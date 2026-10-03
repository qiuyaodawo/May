import { setTimeout as delay } from "node:timers/promises";
import type { ImageData } from "@may/media";
import { definePlugin, defineService, type PluginDefinition } from "@may/plugin";
import {
  boundedJson, boundedBytes, channelAccepts, channelTrigger, checkAttachment, cursorId, deliveryServices,
  type ChannelAccessSettings, type ChannelAdapter, type ChannelAttachment, type ChannelAttachmentData,
  type ChannelCapabilities, type ChannelDeliveryReceipt, type ChannelInput, type ChannelState, type DeliveryRecord, type GroupTrigger,
} from "@may/plugin-delivery";
import { telegramInput, telegramMemberInput, type TelegramUpdate } from "./input.js";
export * from "./input.js";

export interface TelegramSettings extends ChannelAccessSettings { enabled: boolean; botToken?: string; botTokenEnv?: string }
export const telegramChannelService = defineService<ChannelAdapter>({ id: "may.channel.telegram", version: "1.0.0", scope: "host" });
export function createTelegramChannelPlugin(options: { readonly settings: TelegramSettings; readonly token: string; readonly id?: string }): PluginDefinition {
  const settings = structuredClone(options.settings), token = options.token;
  return definePlugin({
    id: options.id ?? "@may/plugin-channel-telegram", version: "0.1.0", scope: "host",
    requires: [{ service: deliveryServices.registry }], provides: [telegramChannelService],
    setup(context) {
      const adapter = new TelegramAdapter(settings, token);
      context.provide(telegramChannelService, adapter);
      context.defer(context.get(deliveryServices.registry).register(adapter));
    },
  });
}
export class TelegramAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = { groups: true, threads: true, nativeReplies: true, messageEdits: true, messageDeletes: false, maxTextLength: 4096, maxAttachmentBytes: 20 * 1024 * 1024, inputAttachments: ["image", "file", "audio", "video"], outputAttachments: ["image"] };
  readonly media = { images: true, maxImageBytes: 32 * 1024 * 1024, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] };
  readonly name = "telegram";
  readonly account: string;
  readonly allowUsers: readonly string[];
  readonly allowGroups: readonly string[];
  private username: string | undefined;
  private state = "starting";
  private readonly settings: TelegramSettings;
  constructor(settings: TelegramSettings, private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot token format");
    this.settings = structuredClone(settings);
    this.account = `telegram:${token.split(":")[0]}`;
    this.allowUsers = Object.freeze([...settings.allowUsers]); this.allowGroups = Object.freeze([...(settings.allowGroups ?? [])]);
  }
  accepts(input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean { return channelAccepts(this.settings, input); }
  triggerFor(input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger { return channelTrigger(this.settings, input); }
  status(): string { return this.state; }
  async run(receive: (input: ChannelInput) => Promise<void>, store: ChannelState, signal: AbortSignal): Promise<void> {
    let initialized = false, backoff = 1000;
    while (!signal.aborted) {
      try {
        if (!initialized) {
          const me = await this.call("getMe", {}, signal) as { id: number; is_bot: boolean; username?: string };
          if (!me.is_bot || `telegram:${me.id}` !== this.account) throw new Error("Bot identity mismatch");
          this.username = me.username;
          const webhook = await this.call("getWebhookInfo", {}, signal) as { url: string };
          if (webhook.url) { this.state = "webhook-conflict"; return; }
          initialized = true;
        }
        const cursor = store.get(cursorId(this.account));
        const updates = await this.call("getUpdates", { offset: cursor?.kind === "cursor" ? cursor.offset : 0, limit: 20, timeout: 20, allowed_updates: ["message", "edited_message", "chat_member"] }, signal) as TelegramUpdate[];
        if (!Array.isArray(updates)) throw new Error("Invalid updates");
        this.state = "polling"; backoff = 1000;
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error("Invalid update ID");
          const input = telegramMemberInput(update, this.account) ?? telegramInput(update, this.account, this.username);
          if (input && this.accepts(input)) await receive(input);
          await store.put({ kind: "cursor", id: cursorId(this.account), offset: update.update_id + 1 });
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramRequestError && [401, 403, 409].includes(error.code)) {
          this.state = error.code === 409 ? "polling-conflict" : "credential-error"; return;
        }
        this.state = "retrying";
        try { await delay(Math.max(backoff, error instanceof TelegramRequestError ? error.retryAfterMs : 0), undefined, { signal }); }
        catch (delayError) { if (!signal.aborted) throw delayError; }
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    this.state = "stopped";
  }
  async send(delivery: DeliveryRecord, signal: AbortSignal, image?: ImageData): Promise<ChannelDeliveryReceipt> {
    const routing = telegramDeliveryRouting(delivery);
    if (image) {
      const prepared = telegramImageRequest(delivery.conversation, image);
      for (const [key, value] of Object.entries(routing)) prepared.body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      const result = await this.call(prepared.method, prepared.body, signal) as { message_id?: number };
      if (!Number.isSafeInteger(result.message_id)) throw new Error("Unconfirmed image delivery");
      return { messageId: String(result.message_id), ...(delivery.threadId ? { threadId: delivery.threadId } : {}) };
    }
    if (delivery.imageId) throw new Error("Image delivery has no media data");
    if (!delivery.text.trim() || delivery.text.length > this.capabilities.maxTextLength) throw new Error("Telegram message exceeds the text limit");
    const result = await this.call("sendMessage", { chat_id: delivery.conversation, text: delivery.text, link_preview_options: { is_disabled: true }, ...routing }, signal) as { message_id?: number };
    if (!Number.isSafeInteger(result.message_id)) throw new Error("Unconfirmed delivery");
    return { messageId: String(result.message_id), ...(delivery.threadId ? { threadId: delivery.threadId } : {}) };
  }
  async readAttachment(input: ChannelInput, attachment: ChannelAttachment, signal: AbortSignal): Promise<ChannelAttachmentData> {
    checkAttachment(this, input, attachment);
    const file = await this.call("getFile", { file_id: attachment.source.fileId }, signal) as { file_path?: string; file_size?: number };
    if (!file.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.split("/").includes("..") || (file.file_size !== undefined && file.file_size > this.capabilities.maxAttachmentBytes)) throw new Error("Invalid Telegram attachment download");
    const response = await this.request(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
    if (!response.ok) throw new Error("Telegram attachment download failed");
    return { data: await boundedBytes(response, this.capabilities.maxAttachmentBytes), ...(attachment.name ? { name: attachment.name } : {}), ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}) };
  }
  private async call(method: string, body: object, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error",
    });
    const data = await boundedJson(response) as { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } };
    if (!response.ok || data.ok !== true) {
      const seconds = data.parameters?.retry_after;
      throw new TelegramRequestError(data.error_code ?? response.status,
        typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3600_000) : 0);
    }
    return data.result;
  }
}
class TelegramRequestError extends Error {
  constructor(readonly code: number, readonly retryAfterMs: number) { super("Telegram request was not confirmed"); }
}
export function telegramImageRequest(conversation: string, image: ImageData): { method: "sendPhoto" | "sendDocument"; body: FormData } {
  if (image.data.byteLength > 32 * 1024 * 1024) throw new Error("Telegram attachment exceeds 32 MiB");
  const photo = ["image/png", "image/jpeg"].includes(image.mediaType) && image.data.byteLength <= 10 * 1024 * 1024 && image.width + image.height <= 10_000 && Math.max(image.width / image.height, image.height / image.width) <= 20;
  const field = photo ? "photo" : "document", body = new FormData();
  body.set("chat_id", conversation); body.set(field, new Blob([new Uint8Array(image.data)], { type: image.mediaType }), `image.${image.mediaType.slice(6)}`);
  return { method: photo ? "sendPhoto" : "sendDocument", body };
}
export function telegramDeliveryRouting(delivery: Pick<DeliveryRecord, "threadId" | "replyTo">): { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  const number = (value: string): number => { const parsed = Number(value); if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error("Invalid Telegram message or topic ID"); return parsed; };
  return { ...(delivery.threadId ? { message_thread_id: number(delivery.threadId) } : {}), ...(delivery.replyTo ? { reply_parameters: { message_id: number(delivery.replyTo) } } : {}) };
}
