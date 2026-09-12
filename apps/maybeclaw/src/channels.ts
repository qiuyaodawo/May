import { setTimeout as delay } from "node:timers/promises";
import type { WSClient } from "@larksuiteoapi/node-sdk";
import type { ChannelInput, ChannelStore, DeliveryRecord } from "./channel-store.js";
import { cursorId } from "./channel-store.js";
import type { TelegramSettings, FeishuSettings } from "./settings.js";

export interface ChannelAdapter {
  readonly name: "telegram" | "feishu";
  readonly account: string;
  readonly allowUsers: readonly string[];
  status(): string;
  run(receive: (input: ChannelInput) => Promise<void>, store: ChannelStore, signal: AbortSignal): Promise<void>;
  /** Exactly one network attempt. An exception is conservatively an unknown outcome. */
  send(delivery: DeliveryRecord, signal: AbortSignal): Promise<void>;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  readonly account: string;
  readonly allowUsers: readonly string[];
  private state = "starting";
  constructor(settings: TelegramSettings, private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot token format");
    this.account = `telegram:${token.split(":")[0]}`;
    this.allowUsers = settings.allowUsers;
  }
  status(): string { return this.state; }
  async run(receive: (input: ChannelInput) => Promise<void>, store: ChannelStore, signal: AbortSignal): Promise<void> {
    let initialized = false;
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        if (!initialized) {
          const me = await this.call("getMe", {}, signal) as { id: number; is_bot: boolean };
          if (!me.is_bot || `telegram:${me.id}` !== this.account) throw new Error("Bot identity mismatch");
          const webhook = await this.call("getWebhookInfo", {}, signal) as { url: string };
          if (webhook.url) { this.state = "webhook-conflict"; return; }
          initialized = true;
        }
        const cursor = store.get(cursorId(this.account));
        const updates = await this.call("getUpdates", { offset: cursor?.kind === "cursor" ? cursor.offset : 0, limit: 20, timeout: 20, allowed_updates: ["message"] }, signal) as TelegramUpdate[];
        if (!Array.isArray(updates)) throw new Error("Invalid updates");
        this.state = "polling"; backoff = 1000;
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error("Invalid update ID");
          const input = telegramInput(update, this.account);
          if (input && this.allowUsers.includes(input.sender)) await receive(input);
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
  async send(delivery: DeliveryRecord, signal: AbortSignal): Promise<void> {
    const result = await this.call("sendMessage", { chat_id: delivery.conversation, text: delivery.text,
      link_preview_options: { is_disabled: true } }, signal) as { message_id?: number };
    if (!Number.isSafeInteger(result.message_id)) throw new Error("Unconfirmed delivery");
  }
  private async call(method: string, body: object, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
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

interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; text?: string; from?: { id?: number; is_bot?: boolean }; chat?: { id?: number; type?: string } };
}
export function telegramInput(update: TelegramUpdate, account: string): ChannelInput | undefined {
  const m = update.message;
  if (m?.chat?.type !== "private" || m.from?.is_bot !== false || !Number.isSafeInteger(m.from.id) || m.from.id !== m.chat.id || typeof m.text !== "string" || !m.text.trim() || m.text.length > 16_384) return undefined;
  return { account, eventId: String(update.update_id), sender: String(m.from.id), conversation: String(m.chat.id), text: m.text };
}

export class FeishuAdapter implements ChannelAdapter {
  readonly name = "feishu";
  readonly account: string;
  readonly allowUsers: readonly string[];
  private ws: WSClient | undefined;
  private state = "starting";
  constructor(private readonly settings: FeishuSettings, private readonly secret: string, private readonly request: typeof fetch = fetch) {
    this.account = `feishu:${settings.appId}`;
    this.allowUsers = settings.allowUsers;
  }
  status(): string { return this.state === "listening" ? this.ws?.getConnectionStatus().state ?? "starting" : this.state; }
  async run(receive: (input: ChannelInput) => Promise<void>, _store: ChannelStore, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
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
          const input = feishuInput(data, this.account);
          if (input && this.allowUsers.includes(input.sender)) await receive(input);
          // Do not await agent execution here: WS events have a short ack deadline.
        },
      }) });
      this.state = "listening";
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally { signal.removeEventListener("abort", close); close(); this.state = "stopped"; }
  }
  async send(delivery: DeliveryRecord, signal: AbortSignal): Promise<void> {
    // Native fetch makes the outbound attempt count explicit; no SDK auto-retry layer.
    const auth = await this.post("/auth/v3/tenant_access_token/internal", { app_id: this.settings.appId, app_secret: this.secret }, signal) as { code?: number; tenant_access_token?: string };
    if (auth.code !== 0 || !auth.tenant_access_token) throw new Error("Feishu authentication failed");
    const result = await this.post("/im/v1/messages?receive_id_type=chat_id", { receive_id: delivery.conversation,
      msg_type: "text", content: JSON.stringify({ text: delivery.text }), uuid: delivery.id.slice(0, 32) }, signal, auth.tenant_access_token) as { code?: number; data?: { message_id?: string } };
    if (result.code !== 0 || !result.data?.message_id) throw new Error("Feishu delivery was not confirmed");
  }
  private async post(path: string, body: object, signal: AbortSignal, token?: string): Promise<unknown> {
    const response = await this.request(`https://open.feishu.cn/open-apis${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error" });
    if (!response.ok) throw new Error("Feishu request was not confirmed");
    return boundedJson(response);
  }
}

interface FeishuEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string };
}
export function feishuInput(event: FeishuEvent, account: string): ChannelInput | undefined {
  const m = event.message;
  const sender = event.sender?.sender_id?.open_id;
  if (event.sender?.sender_type !== "user" || !sender || m?.chat_type !== "p2p" || m.message_type !== "text" || !m.chat_id || !m.message_id || typeof m.content !== "string" || m.content.length > 32_768) return undefined;
  try {
    const { text } = JSON.parse(m.content) as { text?: unknown };
    if (typeof text !== "string" || !text.trim() || text.length > 16_384) return undefined;
    return { account, eventId: m.message_id, sender, conversation: m.chat_id, text };
  } catch { return undefined; }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty platform response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) throw new Error("Platform response limit exceeded");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
