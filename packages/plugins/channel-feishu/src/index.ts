import { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { imagePng, type ImageData } from "@may/media";
import { definePlugin, defineService, type PluginDefinition } from "@may/plugin";
import {
  boundedJson, boundedBytes, channelAccepts, channelTrigger, checkAttachment, deliveryServices,
  type ChannelAccessSettings, type ChannelAdapter, type ChannelAttachment, type ChannelAttachmentData,
  type ChannelCapabilities, type ChannelDeliveryReceipt, type ChannelInput, type ChannelState, type DeliveryRecord, type GroupTrigger,
} from "@may/plugin-delivery";
import { feishuInput, feishuMemberInputs, feishuRecallInput } from "./input.js";
export * from "./input.js";

export interface FeishuSettings extends ChannelAccessSettings { enabled: boolean; appId: string; appSecret?: string; appSecretEnv?: string }
export const feishuChannelService = defineService<ChannelAdapter>({ id: "may.channel.feishu", version: "1.0.0", scope: "host" });
export function createFeishuChannelPlugin(options: { readonly settings: FeishuSettings; readonly secret: string; readonly id?: string }): PluginDefinition {
  const settings = structuredClone(options.settings), secret = options.secret;
  return definePlugin({
    id: options.id ?? "@may/plugin-channel-feishu", version: "0.1.0", scope: "host",
    requires: [{ service: deliveryServices.registry }], provides: [feishuChannelService],
    setup(context) {
      const adapter = new FeishuAdapter(settings, secret);
      context.provide(feishuChannelService, adapter);
      context.defer(context.get(deliveryServices.registry).register(adapter));
    },
  });
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
  private readonly settings: FeishuSettings;
  constructor(settings: FeishuSettings, private readonly secret: string, private readonly request: typeof fetch = fetch) {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(settings.appId) || !secret.trim()) throw new Error("Invalid Feishu app credentials");
    this.settings = structuredClone(settings);
    this.account = `feishu:${settings.appId}`;
    this.allowUsers = Object.freeze([...settings.allowUsers]); this.allowGroups = Object.freeze([...(settings.allowGroups ?? [])]);
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
    if (signal.aborted) return;
    const quiet = () => {};
    const logger = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet };
    const ws = new WSClient({ appId: this.settings.appId, appSecret: this.secret, logger });
    this.ws = ws;
    const close = () => ws.close({ force: true });
    signal.addEventListener("abort", close, { once: true });
    try {
      if (signal.aborted) return;
      await ws.start({ eventDispatcher: new EventDispatcher({ logger }).register({
        "im.message.receive_v1": async data => {
          if (signal.aborted) throw new Error("Host stopping");
          const input = feishuInput(data, this.account, this.botOpenId);
          if (input && this.accepts(input)) {
            if (input.replyTo) input.replyToBot = store.values().some(value => value.kind === "delivery" && value.account === this.account && value.conversation === input.conversation && value.messageId === input.replyTo);
            await receive(input);
          }
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
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally { signal.removeEventListener("abort", close); close(); this.state = "stopped"; }
  }
  async send(delivery: DeliveryRecord, signal: AbortSignal, image?: ImageData): Promise<ChannelDeliveryReceipt> {
    const token = await this.authenticate(signal);
    let imageKey: string | undefined;
    if (image) {
      const upload = await this.post("/im/v1/images", await feishuImageRequest(image), signal, token) as { code?: number; data?: { image_key?: string } };
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
export async function feishuImageRequest(image: ImageData): Promise<FormData> {
  const png = await imagePng(image);
  if (png.byteLength > 10 * 1024 * 1024) throw new Error("Feishu image exceeds 10 MiB");
  const body = new FormData(); body.set("image_type", "message");
  body.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "image.png"); return body;
}
export function feishuDeliveryRequest(delivery: Pick<DeliveryRecord, "id" | "conversation" | "text" | "threadId" | "replyTo">, imageKey?: string): { path: string; body: object } {
  if (delivery.threadId && !delivery.replyTo) throw new Error("Feishu topic delivery requires a reply message ID");
  if (!imageKey && (!delivery.text.trim() || delivery.text.length > 4096)) throw new Error("Feishu message exceeds the text limit");
  const body = { msg_type: imageKey ? "image" : "text", content: JSON.stringify(imageKey ? { image_key: imageKey } : { text: delivery.text }), uuid: delivery.id.slice(0, 32) };
  return delivery.replyTo
    ? { path: `/im/v1/messages/${encodeURIComponent(delivery.replyTo)}/reply`, body: { ...body, ...(delivery.threadId ? { reply_in_thread: true } : {}) } }
    : { path: "/im/v1/messages?receive_id_type=chat_id", body: { ...body, receive_id: delivery.conversation } };
}
