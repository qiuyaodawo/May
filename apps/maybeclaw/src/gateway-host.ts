import { join } from "node:path";
import { ChannelStore, inboxId, validateChannelInput, type ChannelAttachment, type ChannelInput, type ChannelRecord, type DeliveryRecord } from "./channel-store.js";
import type { ChannelAdapter, ChannelAttachmentData, ChannelState } from "./channels.js";
import type { ContentPart } from "@may/core";
import { inspectImage, readEmbeddedImage, type ImageData } from "@may/media";
import { UiProjection } from "@may/ui-client/projection";
import type { LegacyTaskRecord } from "./gateway-migration.js";
import { channelTextPages } from "./channel-text.js";
export { channelTextPages } from "./channel-text.js";
import { AgentGateway } from "./gateway.js";
import { gatewayInput } from "./gateway-input.js";
import { actorKey, entryKey, type GatewayActor, type GatewayCapabilities, type GatewayDelivery, type GatewayEntry, type GatewayMessage, type GatewaySession } from "./gateway-types.js";
import { digest } from "./types.js";

interface PendingInput { id: string; input: ChannelInput; fingerprint?: string; sessionId?: string; state: "pending" | "processing" | "done" | "failed" | "deleted"; error?: string }
interface ChannelReply { id: string; input: ChannelInput; text: string; sessionId?: string; status: "pending" | "sending" | "sent" | "unknown"; after?: string }
interface LegacyDelivery extends Omit<DeliveryRecord, "status"> { status: DeliveryRecord["status"] | "failed"; detail?: string }

export class GatewayHost {
  readonly gateway: AgentGateway;
  private readonly controller = new AbortController();
  private readonly channelRuns: Promise<void>[] = [];
  private readonly channelErrors = new Map<string, string>();
  private processingError: Error | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cycle: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private constructor(readonly options: { gateway: AgentGateway; adapters: readonly ChannelAdapter[] }, private readonly channels: ChannelStore) { this.gateway = options.gateway; }
  static async start(options: { gateway: AgentGateway; adapters: readonly ChannelAdapter[] }): Promise<GatewayHost> {
    const channels = await ChannelStore.open(join(options.gateway.options.directory, "gateway-channels.jsonl"));
    try {
    await channels.remove(channels.values().filter(record => record.kind === "inbox").map(record => record.id));
    for (const cursor of options.gateway.store.list<Parameters<ChannelStore["put"]>[0]>("legacy-cursors")) if (!channels.get(cursor.id)) await channels.put(cursor);
    const host = new GatewayHost(options, channels);
    for (const reply of options.gateway.store.list<ChannelReply>("channel-replies")) if (reply.status === "sending") options.gateway.store.put("channel-replies", reply.id, { ...reply, status: "unknown" });
    for (const delivery of options.gateway.store.list<LegacyDelivery>("legacy-deliveries")) if (delivery.status === "sending") options.gateway.store.put("legacy-deliveries", delivery.id, { ...delivery, status: "unknown" });
    await host.applyMemberChanges(); await options.gateway.restore(); host.start(); return host;
    }
    catch (error) { await channels.close(); throw error; }
  }
  status() { const gateway = this.gateway.status(); return { ...gateway,
    state: gateway.state === "running" && (this.processingError || this.channelErrors.size) ? "degraded" : gateway.state,
    error: this.processingError?.message ?? gateway.error,
    channels: this.options.adapters.map(adapter => ({ account: adapter.account, name: adapter.name, state: this.channelErrors.get(adapter.account) ?? adapter.status(), capabilities: adapter.capabilities })),
    deliveries: this.gateway.store.list<GatewayDelivery>("deliveries").slice(-100),
    legacyDeliveries: this.gateway.store.list<LegacyDelivery>("legacy-deliveries").slice(-100),
    channelReplies: this.gateway.store.list<ChannelReply>("channel-replies").slice(-100) }; }
  private start(): void {
    const state: ChannelState = { get: id => this.channels.get(id), put: record => this.channels.put(record), values: () => [
      ...this.channels.values(),
      ...this.gateway.store.list<PendingInput>("inbox").map((record): ChannelRecord => ({ kind: "inbox", id: record.id, input: record.input, processed: record.state !== "pending" })),
    ] };
    for (const adapter of this.options.adapters) {
      const run = adapter.run(input => this.receive(input), state, this.controller.signal).catch(() => {
        if (!this.controller.signal.aborted) { this.channelErrors.set(adapter.account, "渠道接收中断，请检查连接配置。"); this.gateway.changed(); }
      });
      this.channelRuns.push(run);
    }
    const schedule = () => { if (!this.cycle && !this.controller.signal.aborted && !this.processingError) {
      this.cycle = this.tick().catch(error => {
        this.processingError = error instanceof Error ? error : new Error("Gateway 消息处理失败。");
        this.gateway.changed();
      }).finally(() => { this.cycle = undefined; });
    } };
    this.timer = setInterval(schedule, 300); schedule();
  }
  async receive(input: ChannelInput): Promise<void> {
    validateChannelInput(input);
    const adapter = this.options.adapters.find(item => item.account === input.account);
    if (!adapter || !(adapter.accepts?.(input) ?? adapter.allowUsers.includes(input.sender))) return;
    const id = inboxId(input), existing = this.gateway.store.get<PendingInput>("inbox", id);
    if (existing) { if ((existing.fingerprint ?? digest(existing.input)) !== digest(input)) throw new Error("平台事件 ID 内容冲突。"); return; }
    if (input.eventType === "edit" || input.eventType === "delete") {
      this.gateway.store.transaction(() => { this.applyMessageChange(input); this.gateway.store.put("inbox", id, { id, input, state: "done" }); }); return;
    }
    if (input.eventType === "member-left" || input.eventType === "member-joined") {
      this.gateway.store.put("inbox", id, { id, input, fingerprint: digest(input), state: "pending" } satisfies PendingInput); return;
    }
    const entry = channelEntry(input), reply = input.replyTo && this.gateway.store.get("platform-messages", `${entryKey(entry)}:${input.replyTo}`);
    const explicit = input.mentioned || reply || /^\/(session|agent|history|status|result|cancel|stop|steer|approve|deny)(?:\s|$)/u.test(input.text.trimStart()) || /^@[A-Za-z0-9_.-]+\s/u.test(input.text.trimStart());
    if (entry.kind === "group" && adapter.triggerFor?.(input) !== "all" && !explicit) return;
    this.gateway.store.put("inbox", id, { id, input, fingerprint: digest(input), state: "pending" } satisfies PendingInput);
  }
  private applyMessageChange(input: ChannelInput): void {
    if (!input.messageId) return;
    const original = this.gateway.store.list<PendingInput>("inbox").find(item => item.input.account === input.account && item.input.conversation === input.conversation && (item.input.threadId ?? null) === (input.threadId ?? null) && item.input.messageId === input.messageId && item.input.eventType !== "edit" && item.input.eventType !== "delete");
    if (!original) return;
    if (original.state === "pending") {
      const { attachments: _attachments, ...originalInput } = original.input;
      this.gateway.store.put("inbox", original.id, { ...original, fingerprint: original.fingerprint ?? digest(original.input), state: input.eventType === "delete" ? "deleted" : "pending", ...(input.eventType === "edit" ? { input: { ...originalInput, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) } } : {}) });
    }
    const entry = channelEntry(input), associated = input.messageId && this.gateway.store.get<{ sessionId: string }>("platform-messages", `${entryKey(entry)}:${input.messageId}`);
    this.gateway.recordChannelChange(input, original.state, original.sessionId ?? (associated ? associated.sessionId : undefined));
  }
  private async applyMemberChanges(): Promise<void> {
    for (const item of this.gateway.store.list<PendingInput>("inbox")) {
      if (this.controller.signal.aborted) return;
      if (item.state !== "pending" || !["member-left", "member-joined"].includes(item.input.eventType ?? "")) continue;
      const time = item.input.occurredAt === undefined ? Date.now() : Number(item.input.occurredAt);
      if (!Number.isSafeInteger(time) || time < 0) throw new Error("平台成员事件时间无效。");
      await this.gateway.setMemberAccess(channelEntry(item.input), item.input.sender, item.input.eventType === "member-joined", time);
      this.gateway.store.put("inbox", item.id, { ...item, state: "done" });
    }
  }
  async tick(): Promise<void> {
    await this.applyMemberChanges();
    await this.gateway.maintain();
    for (const item of this.gateway.store.list<PendingInput>("inbox")) {
      if (this.controller.signal.aborted) return;
      if (item.state !== "pending" && item.state !== "processing") continue;
      if (item.input.eventType === "member-left" || item.input.eventType === "member-joined") continue;
      if (!this.gateway.store.get("inbox", item.id)) continue;
      const input = item.input, entry = channelEntry(input), actor: GatewayActor = { kind: "platform", account: input.account, userId: input.sender, conversation: input.conversation, ...(input.threadId ? { threadId: input.threadId } : {}) };
      if (this.gateway.options.settings.access.deniedUsers.includes(actorKey(actor))) { this.gateway.store.put("inbox", item.id, { ...item, state: "failed", error: "访问权限已撤销。" }); continue; }
      this.gateway.store.put("inbox", item.id, { ...item, state: "processing" });
      try {
        const adapter = this.options.adapters.find(value => value.account === input.account);
        if (!adapter || !(adapter.accepts?.(input) ?? adapter.allowUsers.includes(input.sender))) throw new Error("渠道访问权限已撤销。");
        const text = input.text.trim() ? input.text : "请处理附加文件。";
        const request = { requestId: `channel:${item.id}`, entry,
          ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
        let content: ContentPart[] | undefined;
        if (input.attachments?.length) {
          const parsed = gatewayInput(text);
          if (parsed.body === undefined || parsed.words.includes("/steer")) throw new Error("附件需要通过普通消息发送；当前管理命令和 /steer 不接受附件。");
          const targets = this.gateway.resolveTargets(text, actor, request);
          const agents = await Promise.all(targets.agents.map(id => this.gateway.adapter(id)));
          content = await readChannelContent(adapter, input, agents.map(value => value.capabilities), this.controller.signal);
        }
        const receipt = await this.gateway.handle(text, actor, { ...request, ...(content ? { content } : {}) });
        if (receipt.sessionId && !this.gateway.store.get("sessions", receipt.sessionId)) {
          this.gateway.store.delete("inbox", item.id);
          const words = gatewayInput(text).words;
          if (words[0] === "/session" && words[1] === "delete") { const { attachments: _attachments, ...source } = input; this.queueReply({ ...item, input: { ...source, text: "" } }, receipt.text); }
          continue;
        }
        if (!this.gateway.store.get("inbox", item.id)) continue;
        this.queueReply(item, receipt.text, receipt.sessionId);
        this.gateway.store.transaction(() => {
          this.gateway.store.put("inbox", item.id, { ...item, state: "done", ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}) });
          if (receipt.sessionId && input.messageId) for (const change of this.gateway.store.list<{ input: ChannelInput; originalState: string; noticeId?: string }>("message-changes")) {
            if (!change.noticeId && change.input.account === input.account && change.input.conversation === input.conversation && (change.input.threadId ?? null) === (input.threadId ?? null) && change.input.messageId === input.messageId) this.gateway.recordChannelChange(change.input, change.originalState, receipt.sessionId);
          }
        });
      } catch (error) {
        if (!this.gateway.store.get("inbox", item.id) || item.sessionId && !this.gateway.store.get("sessions", item.sessionId)) continue;
        const message = error instanceof Error ? error.message : "消息未完成，请检查会话状态。";
        this.queueReply(item, message); this.gateway.store.put("inbox", item.id, { ...item, state: "failed", error: message });
      }
    }
    await this.deliver();
  }
  private queueReply(item: PendingInput, text: string, sessionId?: string): void {
    const adapter = this.options.adapters.find(value => value.account === item.input.account);
    let after: string | undefined;
    for (const [index, page] of channelTextPages(text, adapter?.capabilities?.maxTextLength ?? 3900).entries()) {
      const id = digest({ input: item.id, kind: "receipt", part: index });
      if (!this.gateway.store.get("channel-replies", id)) this.gateway.store.put("channel-replies", id, { id, input: item.input, text: page,
        ...(sessionId ? { sessionId } : {}), status: "pending", ...(after ? { after } : {}) } satisfies ChannelReply);
      after = id;
    }
  }
  async deliver(): Promise<void> {
    const store = this.gateway.store;
    await this.deliverLegacy();
    for (const delivery of store.list<GatewayDelivery>("deliveries")) {
      if (this.controller.signal.aborted || delivery.status !== "pending") continue;
      if (delivery.after && store.get<GatewayDelivery>("deliveries", delivery.after)?.status !== "sent") continue;
      const adapter = this.options.adapters.find(item => item.account === delivery.entry.account); if (!adapter) continue;
      const entry = delivery.entry, session = store.get<GatewaySession>("sessions", delivery.sessionId);
      if (!session || session.status === "deleting" || (entry.kind === "private" ? !adapter.allowUsers.includes(entry.owner!) : !adapter.allowGroups?.includes(entry.conversation))) continue;
      if (entry.kind === "private" && this.gateway.options.settings.access.deniedUsers.includes(`${entry.account}:${entry.owner}`)) continue;
      let image: ImageData | undefined;
      try {
        if (delivery.image) {
          if (!adapter.capabilities?.outputAttachments.includes("image") || !adapter.media?.images) throw new Error("当前渠道不支持发送图片。");
          image = await readEmbeddedImage(delivery.image.source, this.controller.signal);
          if (image.data.byteLength > adapter.media.maxImageBytes || !adapter.media.mediaTypes.includes(image.mediaType)) throw new Error("图片大小或类型超过当前渠道的限制。");
        }
      } catch (error) {
        if (!store.get("deliveries", delivery.id)) continue;
        const detail = error instanceof Error ? error.message : "图片无法发送。";
        store.put("deliveries", delivery.id, { ...delivery, status: "failed", detail });
        this.queueReply({ id: `${delivery.id}:media-error`, state: "done", input: { account: entry.account, sender: entry.owner ?? "gateway", conversation: entry.conversation,
          kind: entry.kind, eventId: delivery.id, text: detail, ...(entry.threadId ? { threadId: entry.threadId } : {}), ...(delivery.replyTo ? { messageId: delivery.replyTo } : {}) } }, detail, delivery.sessionId);
        this.gateway.changed(); continue;
      }
      if (!store.get("deliveries", delivery.id) || store.get<GatewaySession>("sessions", delivery.sessionId)?.status === "deleting") continue;
      store.put("deliveries", delivery.id, { ...delivery, status: "sending" });
      try {
        const result = await adapter.send({ kind: "delivery", id: delivery.id, account: entry.account, sender: entry.owner ?? "gateway", conversation: entry.conversation,
          text: delivery.text, status: "pending", conversationKind: entry.kind, ...(entry.threadId ? { threadId: entry.threadId } : {}), ...(delivery.replyTo ? { replyTo: delivery.replyTo } : {}) }, this.controller.signal, image);
        if (!store.get("deliveries", delivery.id) || !store.get("sessions", delivery.sessionId)) continue;
        store.put("deliveries", delivery.id, { ...delivery, status: "sent", ...(result?.messageId ? { platformMessageId: result.messageId } : {}) });
        if (result?.messageId) {
          const message = store.get<GatewayMessage>("messages", delivery.messageId), key = `${entryKey(entry)}:${result.messageId}`;
          store.put("platform-messages", key, { id: key, sessionId: delivery.sessionId, agentId: message?.agentId });
        }
      } catch { if (store.get("deliveries", delivery.id)) store.put("deliveries", delivery.id, { ...delivery, status: "unknown" }); }
      this.gateway.changed();
    }
    for (const reply of store.list<ChannelReply>("channel-replies")) {
      if (this.controller.signal.aborted || reply.status !== "pending") continue;
      if (!store.get("channel-replies", reply.id)) continue;
      if (reply.after && store.get<ChannelReply>("channel-replies", reply.after)?.status !== "sent") continue;
      const adapter = this.options.adapters.find(item => item.account === reply.input.account); if (!adapter || !(adapter.accepts?.(reply.input) ?? adapter.allowUsers.includes(reply.input.sender))) continue;
      store.put("channel-replies", reply.id, { ...reply, status: "sending" });
      try {
        const delivery: DeliveryRecord = { kind: "delivery", id: reply.id, account: reply.input.account, sender: reply.input.sender,
          conversation: reply.input.conversation, text: reply.text, status: "pending", ...(reply.input.kind ? { conversationKind: reply.input.kind } : {}), ...(reply.input.threadId ? { threadId: reply.input.threadId } : {}), ...(reply.input.messageId ? { replyTo: reply.input.messageId } : {}) };
        const result = await adapter.send(delivery, this.controller.signal);
        if (!store.get("channel-replies", reply.id)) continue;
        store.put("channel-replies", reply.id, { ...reply, status: "sent" });
        if (result?.messageId && reply.sessionId) { const key = `${entryKey(channelEntry(reply.input))}:${result.messageId}`; store.put("platform-messages", key, { id: key, sessionId: reply.sessionId }); }
      } catch { if (store.get("channel-replies", reply.id)) store.put("channel-replies", reply.id, { ...reply, status: "unknown" }); }
    }
  }
  retryLegacyDelivery(id: string, actor: GatewayActor, confirmUnknown = false): LegacyDelivery {
    if (actor.kind !== "operator") throw new Error("重新发送历史消息需要服务管理员权限。");
    const delivery = this.gateway.store.get<LegacyDelivery>("legacy-deliveries", id);
    if (!delivery) throw new Error("历史投递记录不存在。");
    if (delivery.status === "sending" || delivery.status === "sent") throw new Error("该消息正在发送或已经发送。");
    if (delivery.status === "unknown" && !confirmUnknown) throw new Error("发送结果未知，确认可能重复后才能重新发送。");
    const pending: LegacyDelivery = { ...delivery, status: "pending" };
    this.gateway.store.put("legacy-deliveries", id, pending); this.gateway.changed(); return pending;
  }
  private async deliverLegacy(): Promise<void> {
    const store = this.gateway.store;
    for (const delivery of store.list<LegacyDelivery>("legacy-deliveries")) {
      if (this.controller.signal.aborted || delivery.status !== "pending") continue;
      if (delivery.after && store.get<LegacyDelivery>("legacy-deliveries", delivery.after)?.status !== "sent") continue;
      const adapter = this.options.adapters.find(value => value.account === delivery.account);
      if (!adapter) continue;
      const input: ChannelInput = { account: delivery.account, sender: delivery.sender, conversation: delivery.conversation, eventId: delivery.id, text: delivery.text,
        kind: delivery.conversationKind ?? "private", ...(delivery.threadId ? { threadId: delivery.threadId } : {}) };
      if (!(adapter.accepts?.(input) ?? adapter.allowUsers.includes(input.sender)) || this.gateway.options.settings.access.deniedUsers.includes(`${delivery.account}:${delivery.sender}`)) {
        store.put("legacy-deliveries", delivery.id, { ...delivery, status: "suppressed" }); continue;
      }
      let image: ImageData | undefined;
      try {
        if (delivery.imageId) {
          const task = delivery.taskId && store.get<LegacyTaskRecord>("legacy-tasks", delivery.taskId);
          if (!task || !task.origins.some(origin => origin.account === delivery.account && origin.sender === delivery.sender && origin.conversation === delivery.conversation)) throw new Error("历史附件缺少可核验的来源。");
          if (!adapter.media?.images || !adapter.capabilities?.outputAttachments.includes("image")) throw new Error("当前渠道不支持发送历史图片。");
          const projection = new UiProjection(Infinity); projection.history(task.history);
          const source = projection.mediaSources.get(delivery.imageId);
          if (!source) throw new Error("历史任务中不存在该附件。");
          image = await readEmbeddedImage(source, this.controller.signal);
          if (image.data.byteLength > adapter.media.maxImageBytes || !adapter.media.mediaTypes.includes(image.mediaType)) throw new Error("历史图片超过渠道限制。");
        }
      } catch (error) {
        if (!store.get("legacy-deliveries", delivery.id)) continue;
        store.put("legacy-deliveries", delivery.id, { ...delivery, status: "failed", detail: error instanceof Error ? error.message : "历史附件无法发送。" });
        this.gateway.changed(); continue;
      }
      if (!store.get("legacy-deliveries", delivery.id)) continue;
      store.put("legacy-deliveries", delivery.id, { ...delivery, status: "sending" });
      try {
        const result = await adapter.send({ ...delivery, status: "pending" }, this.controller.signal, image);
        if (!store.get("legacy-deliveries", delivery.id)) continue;
        store.put("legacy-deliveries", delivery.id, { ...delivery, status: "sent", ...(result?.messageId ? { messageId: result.messageId } : {}) });
      } catch { if (store.get("legacy-deliveries", delivery.id)) store.put("legacy-deliveries", delivery.id, { ...delivery, status: "unknown" }); }
      this.gateway.changed();
    }
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.controller.abort(); if (this.timer) clearInterval(this.timer);
      await this.cycle; await Promise.all(this.channelRuns);
      await this.channels.close(); await this.gateway.close();
    })();
  }
}
export async function readChannelContent(adapter: ChannelAdapter, input: ChannelInput, agents: readonly GatewayCapabilities[], signal: AbortSignal): Promise<ContentPart[]> {
  const attachments = input.attachments ?? [], capabilities = adapter.capabilities;
  if (!capabilities || !adapter.readAttachment) throw new Error("当前渠道不支持读取附件。");
  if (!agents.length) throw new Error("没有可接收附件的目标 Agent。");
  for (const attachment of attachments) {
    if (!capabilities.inputAttachments.includes(attachment.kind)) throw new Error(`当前渠道不支持读取 ${attachment.kind} 附件。`);
    if (agents.some(agent => !agent.media.includes(attachment.kind))) throw new Error(`目标 Agent 不支持 ${attachment.kind} 附件。请检查目标 Agent 的媒体配置。`);
    if (attachment.size !== undefined && attachment.size > capabilities.maxAttachmentBytes) throw new Error("附件大小超过渠道限制。");
  }
  const content: ContentPart[] = [];
  let size = 0;
  for (const attachment of attachments) {
    signal.throwIfAborted();
    const data = await adapter.readAttachment(input, attachment, signal);
    size += data.data.byteLength;
    if (size > capabilities.maxAttachmentBytes) throw new Error("本条消息的附件总大小超过渠道限制。");
    content.push(await channelAttachmentContent(attachment, data, capabilities.maxAttachmentBytes));
  }
  return content;
}
export async function channelAttachmentContent(attachment: ChannelAttachment, data: ChannelAttachmentData, maximum: number): Promise<ContentPart> {
  if (!data.data.byteLength || data.data.byteLength > maximum) throw new Error("附件内容为空或超过大小限制。");
  let mediaType = data.mediaType ?? attachment.mediaType ?? "application/octet-stream";
  if (attachment.kind === "image") mediaType = (await inspectImage(data.data)).mediaType;
  if (attachment.kind === "unsupported") throw new Error("无法处理此附件类型。");
  if (attachment.kind === "audio" && !mediaType.startsWith("audio/")) throw new Error("音频附件缺少有效内容类型。");
  if (attachment.kind === "video" && !mediaType.startsWith("video/")) throw new Error("视频附件缺少有效内容类型。");
  const source = { type: "base64" as const, mediaType, data: Buffer.from(data.data).toString("base64") };
  return attachment.kind === "image" ? { type: "image", source } : attachment.kind === "audio" ? { type: "audio", source }
    : { type: "file", source, ...(data.name ?? attachment.name ? { name: data.name ?? attachment.name } : {}) };
}
export function channelEntry(input: ChannelInput): GatewayEntry {
  return { account: input.account, conversation: input.conversation, kind: input.kind ?? "private",
    ...(input.kind === "group" ? {} : { owner: input.sender }), ...(input.threadId ? { threadId: input.threadId } : {}) };
}
