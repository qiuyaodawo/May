import { setTimeout as delay } from "node:timers/promises";
import { imagePng, type ImageData, type MediaCapabilities } from "@may/media";
import type { WSClient } from "@larksuiteoapi/node-sdk";
import type { ChannelAttachment, ChannelDeliveryReceipt, ChannelInput, ChannelStore, DeliveryRecord } from "./channel-store.js";
import { cursorId } from "./channel-store.js";
import type { ChannelAccessSettings, GroupTrigger, TelegramSettings, FeishuSettings } from "./settings.js";
import { feishuInput, feishuMemberInputs, feishuRecallInput, telegramInput, telegramMemberInput, type TelegramUpdate } from "./channel-input.js";
export { feishuInput, feishuMemberInputs, feishuRecallInput, telegramInput, telegramMemberInput } from "./channel-input.js";

export interface ChannelCapabilities {
  groups: boolean; threads: boolean; nativeReplies: boolean; messageEdits: boolean; messageDeletes: boolean;
  maxTextLength: number; maxAttachmentBytes: number;
  inputAttachments: readonly ChannelAttachment["kind"][]; outputAttachments: readonly ChannelAttachment["kind"][];
}
export interface ChannelAttachmentData { data: Uint8Array; name?: string; mediaType?: string }
export type ChannelState = Pick<ChannelStore, "get" | "put" | "values">;

export interface ChannelAdapter {
  readonly media?: MediaCapabilities;
  readonly name: "telegram" | "feishu";
  readonly account: string;
  readonly allowUsers: readonly string[];
  readonly allowGroups?: readonly string[];
  readonly capabilities?: ChannelCapabilities;
  accepts?(input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean;
  triggerFor?(input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger;
  status(): string;
  run(receive: (input: ChannelInput) => Promise<void>, store: ChannelState, signal: AbortSignal): Promise<void>;
  /** 每次调用仅尝试发送一次，异常结果交给 Gateway 保存。 */
  send(delivery: DeliveryRecord, signal: AbortSignal, image?: ImageData): Promise<ChannelDeliveryReceipt | void>;
  readAttachment?(input: ChannelInput, attachment: ChannelAttachment, signal: AbortSignal): Promise<ChannelAttachmentData>;
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
  constructor(private readonly settings: TelegramSettings, private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot token format");
    this.account = `telegram:${token.split(":")[0]}`;
    this.allowUsers = settings.allowUsers;
    this.allowGroups = settings.allowGroups ?? [];
  }
  accepts(input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean { return channelAccepts(this.settings, input); }
  triggerFor(input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger { return channelTrigger(this.settings, input); }
  status(): string { return this.state; }
  async run(receive: (input: ChannelInput) => Promise<void>, store: ChannelState, signal: AbortSignal): Promise<void> {
    let initialized = false;
    let backoff = 1000;
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
          // Upstream ack happens only in the NEXT getUpdates, after inbox + cursor fsync.
          await store.put({ kind: "cursor", id: cursorId(this.account), offset: update.update_id + 1 });
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramRequestError && [401, 403, 409].includes(error.code)) {
          this.state = error.code === 409 ? "polling-conflict" : "credential-error";
          return;
        }
        this.state = "retrying";
        await delay(Math.max(backoff, error instanceof TelegramRequestError ? error.retryAfterMs : 0), undefined, { signal }).catch(() => {});
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
    const result = await this.call("sendMessage", { chat_id: delivery.conversation, text: delivery.text,
      link_preview_options: { is_disabled: true }, ...routing }, signal) as { message_id?: number };
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
    // Never expose platform error descriptions, request URLs or credential-bearing SDK errors.
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

export class FeishuAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = { groups: true, threads: true, nativeReplies: true, messageEdits: false, messageDeletes: true, maxTextLength: 4096, maxAttachmentBytes: 20 * 1024 * 1024, inputAttachments: ["image", "file", "audio", "video"], outputAttachments: ["image"] };
  readonly media = { images: true, maxImageBytes: 10 * 1024 * 1024, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] };
  readonly name = "feishu";
  readonly account: string;
  readonly allowUsers: readonly string[];
  readonly allowGroups: readonly string[];
  private botOpenId: string | undefined;
  private ws: WSClient | undefined;
  private state = "starting";
  constructor(private readonly settings: FeishuSettings, private readonly secret: string, private readonly request: typeof fetch = fetch) {
    this.account = `feishu:${settings.appId}`;
    this.allowUsers = settings.allowUsers;
    this.allowGroups = settings.allowGroups ?? [];
  }
  accepts(input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean { return channelAccepts(this.settings, input); }
  triggerFor(input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger { return channelTrigger(this.settings, input); }
  status(): string { return this.state === "listening" ? this.ws?.getConnectionStatus().state ?? "starting" : this.state; }
  async run(receive: (input: ChannelInput) => Promise<void>, store: ChannelState, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const token = await this.authenticate(signal);
    const identity = await this.get("/bot/v3/info", signal, token) as { code?: number; bot?: { open_id?: string } };
    if (identity.code !== 0 || !identity.bot?.open_id) throw new Error("Feishu bot identity is unavailable");
    this.botOpenId = identity.bot.open_id;
    const { EventDispatcher, WSClient } = await import("@larksuiteoapi/node-sdk");
    if (signal.aborted) return;
    // SDK debug/error messages can contain full payloads or credential-bearing requests.
    const noop = () => {};
    const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
    const ws = new WSClient({ appId: this.settings.appId, appSecret: this.secret, logger });
    this.ws = ws;
    const close = () => ws.close({ force: true });
    signal.addEventListener("abort", close, { once: true });
    try {
      if (signal.aborted) return;
      await ws.start({ eventDispatcher: new EventDispatcher({ logger }).register({
        "im.message.receive_v1": async (data) => {
          if (signal.aborted) throw new Error("Host stopping");
          const input = feishuInput(data, this.account, this.botOpenId);
          if (input && this.accepts(input)) {
            if (input.replyTo) input.replyToBot = store.values().some(value => value.kind === "delivery" && value.account === this.account && value.conversation === input.conversation && value.messageId === input.replyTo);
            await receive(input);
          }
          // Do not await agent execution here: WS events have a short ack deadline.
        },
        "im.message.recalled_v1": async data => {
          if (signal.aborted) throw new Error("Host stopping");
          const original = store.values().find(value => value.kind === "inbox" && value.input.account === this.account && value.input.conversation === data.chat_id && value.input.messageId === data.message_id);
          if (original?.kind === "inbox" && this.accepts(original.input)) await receive(feishuRecallInput(data, original.input));
        },
        "im.chat.member.user.added_v1": async data => {
          if (signal.aborted) throw new Error("Host stopping");
          for (const input of feishuMemberInputs(data, this.account, true)) if (this.accepts(input)) await receive(input);
        },
        "im.chat.member.user.deleted_v1": async data => {
          if (signal.aborted) throw new Error("Host stopping");
          for (const input of feishuMemberInputs(data, this.account, false)) if (this.accepts(input)) await receive(input);
        },
        "im.chat.member.user.withdrawn_v1": async data => {
          if (signal.aborted) throw new Error("Host stopping");
          for (const input of feishuMemberInputs(data, this.account, false)) if (this.accepts(input)) await receive(input);
        },
      }) });
      this.state = "listening";
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally { signal.removeEventListener("abort", close); close(); this.state = "stopped"; }
  }
  async send(delivery: DeliveryRecord, signal: AbortSignal, image?: ImageData): Promise<ChannelDeliveryReceipt> {
    // Native fetch makes the outbound attempt count explicit; no SDK auto-retry layer.
    const token = await this.authenticate(signal);
    let imageKey: string | undefined;
    if (image) {
      const form = await feishuImageRequest(image);
      const upload = await this.post("/im/v1/images", form, signal, token) as { code?: number; data?: { image_key?: string } };
      if (upload.code !== 0 || !upload.data?.image_key) throw new Error("Feishu image upload was not confirmed");
      imageKey = upload.data.image_key;
    }
    if (delivery.imageId && !imageKey) throw new Error("Image delivery has no media data");
    const prepared = feishuDeliveryRequest(delivery, imageKey);
    const result = await this.post(prepared.path, prepared.body, signal, token) as { code?: number; data?: { message_id?: string; thread_id?: string } };
    if (result.code !== 0 || !result.data?.message_id) throw new Error("Feishu delivery was not confirmed");
    return { messageId: result.data.message_id, ...(result.data.thread_id ? { threadId: result.data.thread_id } : delivery.threadId ? { threadId: delivery.threadId } : {}) };
  }
  async readAttachment(input: ChannelInput, attachment: ChannelAttachment, signal: AbortSignal): Promise<ChannelAttachmentData> {
    checkAttachment(this, input, attachment);
    if (attachment.source.messageId !== input.messageId) throw new Error("Attachment does not belong to this message");
    const token = await this.authenticate(signal);
    const path = `/im/v1/messages/${encodeURIComponent(input.messageId!)}/resources/${encodeURIComponent(attachment.source.fileId)}?type=${attachment.kind === "image" ? "image" : "file"}`;
    const response = await this.request(`https://open.feishu.cn/open-apis${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
    if (!response.ok || response.headers.get("content-type")?.includes("application/json")) throw new Error("Feishu attachment download failed");
    const mediaType = attachment.mediaType ?? response.headers.get("content-type")?.split(";")[0];
    return { data: await boundedBytes(response, this.capabilities.maxAttachmentBytes), ...(attachment.name ? { name: attachment.name } : {}), ...(mediaType ? { mediaType } : {}) };
  }
  private async authenticate(signal: AbortSignal): Promise<string> {
    const auth = await this.post("/auth/v3/tenant_access_token/internal", { app_id: this.settings.appId, app_secret: this.secret }, signal) as { code?: number; tenant_access_token?: string };
    if (auth.code !== 0 || !auth.tenant_access_token) throw new Error("Feishu authentication failed");
    return auth.tenant_access_token;
  }
  private async get(path: string, signal: AbortSignal, token: string): Promise<unknown> {
    const response = await this.request(`https://open.feishu.cn/open-apis${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
    if (!response.ok) throw new Error("Feishu request was not confirmed");
    return boundedJson(response);
  }
  private async post(path: string, body: object, signal: AbortSignal, token?: string): Promise<unknown> {
    const response = await this.request(`https://open.feishu.cn/open-apis${path}`, { method: "POST",
      headers: { ...(body instanceof FormData ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
    if (!response.ok) throw new Error("Feishu request was not confirmed");
    return boundedJson(response);
  }
}

export function telegramImageRequest(conversation: string, image: ImageData): { method: "sendPhoto" | "sendDocument"; body: FormData } {
  if (image.data.byteLength > 32 * 1024 * 1024) throw new Error("Telegram attachment exceeds 32 MiB");
  const photo = ["image/png", "image/jpeg"].includes(image.mediaType) && image.data.byteLength <= 10 * 1024 * 1024 && image.width + image.height <= 10_000 && Math.max(image.width / image.height, image.height / image.width) <= 20;
  const field = photo ? "photo" : "document", body = new FormData();
  body.set("chat_id", conversation);
  body.set(field, new Blob([new Uint8Array(image.data)], { type: image.mediaType }), `image.${image.mediaType.slice(6)}`);
  return { method: photo ? "sendPhoto" : "sendDocument", body };
}

export async function feishuImageRequest(image: ImageData): Promise<FormData> {
  const png = await imagePng(image);
  if (png.byteLength > 10 * 1024 * 1024) throw new Error("Feishu image exceeds 10 MiB");
  const body = new FormData(); body.set("image_type", "message");
  body.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "image.png");
  return body;
}

async function boundedJson(response: Response): Promise<unknown> {
  return JSON.parse(Buffer.from(await boundedBytes(response, 1024 * 1024)).toString("utf8"));
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty platform response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) throw new Error("Platform response limit exceeded");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export function channelAccepts(settings: ChannelAccessSettings, input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean {
  return input.kind === "group" ? (settings.allowGroups ?? []).includes(input.conversation) : settings.allowUsers.includes(input.sender);
}
export function channelTrigger(settings: ChannelAccessSettings, input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger {
  return settings.entranceTriggers?.find(value => value.conversation === input.conversation && value.threadId === input.threadId)?.trigger
    ?? settings.entranceTriggers?.find(value => value.conversation === input.conversation && value.threadId === undefined)?.trigger
    ?? settings.groupTrigger ?? "explicit";
}
export function telegramDeliveryRouting(delivery: Pick<DeliveryRecord, "threadId" | "replyTo">): { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  const number = (value: string): number => { const parsed = Number(value); if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error("Invalid Telegram message or topic ID"); return parsed; };
  return { ...(delivery.threadId ? { message_thread_id: number(delivery.threadId) } : {}), ...(delivery.replyTo ? { reply_parameters: { message_id: number(delivery.replyTo) } } : {}) };
}
export function feishuDeliveryRequest(delivery: Pick<DeliveryRecord, "id" | "conversation" | "text" | "threadId" | "replyTo">, imageKey?: string): { path: string; body: object } {
  if (delivery.threadId && !delivery.replyTo) throw new Error("Feishu topic delivery requires a reply message ID");
  if (!imageKey && (!delivery.text.trim() || delivery.text.length > 4096)) throw new Error("Feishu message exceeds the text limit");
  const body = { msg_type: imageKey ? "image" : "text", content: JSON.stringify(imageKey ? { image_key: imageKey } : { text: delivery.text }), uuid: delivery.id.slice(0, 32) };
  return delivery.replyTo
    ? { path: `/im/v1/messages/${encodeURIComponent(delivery.replyTo)}/reply`, body: { ...body, ...(delivery.threadId ? { reply_in_thread: true } : {}) } }
    : { path: "/im/v1/messages?receive_id_type=chat_id", body: { ...body, receive_id: delivery.conversation } };
}
function checkAttachment(adapter: ChannelAdapter, input: ChannelInput, attachment: ChannelAttachment): void {
  if (input.account !== adapter.account || !adapter.accepts?.(input) || !input.attachments?.some(value => JSON.stringify(value) === JSON.stringify(attachment))) throw new Error("Attachment access denied");
  if (attachment.source.platform !== adapter.name || !adapter.capabilities?.inputAttachments.includes(attachment.kind)) throw new Error("Unsupported channel attachment");
  if (attachment.size !== undefined && attachment.size > adapter.capabilities.maxAttachmentBytes) throw new Error("Channel attachment exceeds the size limit");
}
