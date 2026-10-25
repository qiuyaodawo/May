import type { AgentApplicationEvent } from "@sortedyuan/application";
import type { ChannelDeliveryReceipt, ChannelInput, ChannelRecord, DeliveryRecord } from "./channel-store.js";
import { inboxId, validateChannelInput } from "./channel-store.js";
import type { LegacyTaskRecord } from "./gateway-migration.js";
import type { GatewayReceipt } from "./gateway.js";
import type { GatewayStore } from "./gateway-store.js";
import { actorKey, entryKey, type GatewayDelivery, type GatewayEntry, type GatewayMessage, type GatewaySession } from "./gateway-types.js";
import { digest } from "./types.js";

export interface PendingInput {
  id: string;
  input: ChannelInput;
  fingerprint?: string;
  sessionId?: string;
  state: "pending" | "processing" | "done" | "failed" | "deleted";
  error?: string;
}
export interface ChannelReply {
  id: string;
  input: ChannelInput;
  text: string;
  sessionId?: string;
  status: "pending" | "sending" | "sent" | "unknown";
  after?: string;
}
export interface LegacyDelivery extends Omit<DeliveryRecord, "status"> {
  status: DeliveryRecord["status"] | "failed";
  detail?: string;
}
export interface GatewayEventRecord { id: string; sessionId: string; taskId: string; event: AgentApplicationEvent; at: number }
export interface PlatformMessage { id?: string; sessionId: string; agentId?: string }
export interface ChannelMessageChange { id: string; input: ChannelInput; originalState: PendingInput["state"]; sessionId?: string; noticeId?: string }
type DeliveryOutcome = "sending" | "sent" | "unknown";
export type DeliverySelection = "current" | "reply" | "legacy";

/** 渠道宿主只能访问接收、投递及其必要的会话信息。 */
export interface GatewayChannelRepository {
  inputs(): readonly PendingInput[];
  input(id: string): PendingInput | undefined;
  hasInput(input: ChannelInput): boolean;
  acceptInput(input: ChannelInput): void;
  changeInput(input: ChannelInput, recordChange: (input: ChannelInput, state: PendingInput["state"], sessionId?: string) => void): void;
  beginInput(id: string): boolean;
  completeMemberInput(id: string): void;
  finishInput(id: string, receipt: GatewayReceipt, pages: readonly string[], recordChange: (change: ChannelMessageChange, sessionId: string) => void): void;
  failInput(id: string, error: string, pages: readonly string[]): void;
  removeInput(id: string): void;
  queueReply(item: Pick<PendingInput, "id" | "input">, pages: readonly string[], sessionId?: string): void;
  session(id: string): GatewaySession | undefined;
  platformMessage(entry: Pick<GatewayEntry, "account" | "conversation" | "threadId">, messageId: string): PlatformMessage | undefined;
  deliveries(): readonly GatewayDelivery[];
  delivery(id: string): GatewayDelivery | undefined;
  replies(): readonly ChannelReply[];
  reply(id: string): ChannelReply | undefined;
  legacyDeliveries(): readonly LegacyDelivery[];
  legacyDelivery(id: string): LegacyDelivery | undefined;
  legacyTask(id: string): LegacyTaskRecord | undefined;
  legacyCursors(): readonly ChannelRecord[];
  recoverChannelDeliveries(): void;
  commitDelivery(selection: DeliverySelection, id: string, status: DeliveryOutcome, receipt?: ChannelDeliveryReceipt): void;
  failDelivery(selection: "current" | "legacy", id: string, detail: string): void;
  suppressLegacyDelivery(id: string): void;
  retryLegacyDelivery(id: string, confirmUnknown: boolean): LegacyDelivery;
}

/** Gateway 与渠道宿主共享业务记录，全部关联写入使用同一 SQLite 事务。 */
export class GatewayRepository implements GatewayChannelRepository {
  constructor(private readonly store: GatewayStore) {}

  inputs(): PendingInput[] { return this.store.list("inbox"); }
  input(id: string): PendingInput | undefined { return this.store.get("inbox", id); }
  hasInput(input: ChannelInput): boolean {
    const previous = this.input(inboxId(input));
    if (!previous) return false;
    if ((previous.fingerprint ?? digest(previous.input)) !== digest(input)) throw new Error("平台事件 ID 内容冲突。");
    return true;
  }
  acceptInput(input: ChannelInput): void {
    validateChannelInput(input);
    if (this.hasInput(input)) return;
    const id = inboxId(input);
    this.store.put("inbox", id, { id, input, fingerprint: digest(input), state: "pending" } satisfies PendingInput);
  }
  changeInput(input: ChannelInput, recordChange: (input: ChannelInput, state: PendingInput["state"], sessionId?: string) => void): void {
    if (!input.messageId || input.eventType !== "edit" && input.eventType !== "delete") throw new Error("平台消息变更需要原消息 ID。");
    validateChannelInput(input);
    this.store.transaction(() => {
      if (this.hasInput(input)) return;
      const original = this.inputs().find(item => sameMessage(item.input, input) && item.input.eventType !== "edit" && item.input.eventType !== "delete");
      if (original) {
        if (original.state === "pending") {
          const { attachments: _attachments, ...previous } = original.input;
          this.store.put("inbox", original.id, { ...original, fingerprint: original.fingerprint ?? digest(original.input),
            state: input.eventType === "delete" ? "deleted" : "pending",
            ...(input.eventType === "edit" ? { input: { ...previous, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) } } : {}) } satisfies PendingInput);
        }
        recordChange(input, original.state, original.sessionId ?? this.platformMessage(input, input.messageId!)?.sessionId);
      }
      const id = inboxId(input);
      this.store.put("inbox", id, { id, input, fingerprint: digest(input), state: "done" } satisfies PendingInput);
    });
  }
  beginInput(id: string): boolean {
    const current = this.input(id);
    if (!current) return false;
    if (current.state !== "pending" && current.state !== "processing") throw new Error("输入当前不可执行。");
    this.store.put("inbox", id, { ...current, state: "processing" } satisfies PendingInput);
    return true;
  }
  finishInput(id: string, receipt: GatewayReceipt, pages: readonly string[], recordChange: (change: ChannelMessageChange, sessionId: string) => void): void {
    this.store.transaction(() => {
      const current = this.input(id);
      if (!current) return;
      if (receipt.sessionId && !this.session(receipt.sessionId)) { this.removeInput(id); return; }
      this.queueReply(current, pages, receipt.sessionId);
      this.store.put("inbox", id, { ...current, state: "done", ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}) } satisfies PendingInput);
      if (receipt.sessionId && current.input.messageId) {
        for (const change of this.store.list<ChannelMessageChange>("message-changes")) {
          if (!change.noticeId && sameMessage(change.input, current.input)) recordChange(change, receipt.sessionId);
        }
      }
    });
  }
  completeMemberInput(id: string): void {
    const current = this.input(id);
    if (!current) return;
    if (!["member-left", "member-joined"].includes(current.input.eventType ?? "")) throw new Error("输入必须为成员变更。");
    this.store.put("inbox", id, { ...current, state: "done" } satisfies PendingInput);
  }
  failInput(id: string, error: string, pages: readonly string[]): void {
    this.store.transaction(() => {
      const current = this.input(id);
      if (!current || current.sessionId && !this.session(current.sessionId)) return;
      this.queueReply(current, pages, current.sessionId);
      this.store.put("inbox", id, { ...current, state: "failed", error } satisfies PendingInput);
    });
  }
  removeInput(id: string): void { this.store.delete("inbox", id); }
  queueReply(item: Pick<PendingInput, "id" | "input">, pages: readonly string[], sessionId?: string): void {
    this.store.transaction(() => {
      if (sessionId && !this.session(sessionId)) return;
      let after: string | undefined;
      for (const [index, text] of pages.entries()) {
        const id = digest({ input: item.id, kind: "receipt", part: index });
        if (!this.reply(id)) this.store.put("channel-replies", id, { id, input: item.input, text, status: "pending",
          ...(sessionId ? { sessionId } : {}), ...(after ? { after } : {}) } satisfies ChannelReply);
        after = id;
      }
    });
  }
  session(id: string): GatewaySession | undefined { return this.store.get("sessions", id); }
  platformMessage(entry: Pick<GatewayEntry, "account" | "conversation" | "threadId">, messageId: string): PlatformMessage | undefined {
    return this.store.get("platform-messages", `${entryKey(entry)}:${messageId}`);
  }
  registerPlatformMessage(entry: Pick<GatewayEntry, "account" | "conversation" | "threadId">, messageId: string, message: PlatformMessage): void {
    if (!this.session(message.sessionId)) throw new Error("平台消息所属会话不存在。");
    const id = `${entryKey(entry)}:${messageId}`;
    this.store.put("platform-messages", id, { ...message, id });
  }
  deliveries(): GatewayDelivery[] { return this.store.list("deliveries"); }
  delivery(id: string): GatewayDelivery | undefined { return this.store.get("deliveries", id); }
  replies(): ChannelReply[] { return this.store.list("channel-replies"); }
  reply(id: string): ChannelReply | undefined { return this.store.get("channel-replies", id); }
  legacyDeliveries(): LegacyDelivery[] { return this.store.list("legacy-deliveries"); }
  legacyDelivery(id: string): LegacyDelivery | undefined { return this.store.get("legacy-deliveries", id); }
  legacyTask(id: string): LegacyTaskRecord | undefined { return this.store.get("legacy-tasks", id); }
  legacyCursors(): ChannelRecord[] { return this.store.list("legacy-cursors"); }
  enqueueDelivery(delivery: GatewayDelivery): void {
    if (!this.session(delivery.sessionId)) throw new Error("投递所属会话不存在。");
    if (this.delivery(delivery.id)) throw new Error("投递 ID 已经存在。");
    if (delivery.status !== "pending") throw new Error("新投递必须等待发送。");
    this.store.put("deliveries", delivery.id, delivery);
  }
  recoverDeliveries(): void {
    this.recoverSelectedDeliveries(["current", "reply", "legacy"]);
  }
  recoverChannelDeliveries(): void {
    this.recoverSelectedDeliveries(["reply", "legacy"]);
  }
  private recoverSelectedDeliveries(selections: readonly DeliverySelection[]): void {
    this.store.transaction(() => {
      for (const selection of selections) {
        const collection = deliveryCollection(selection);
        for (const record of this.store.list<GatewayDelivery | ChannelReply | LegacyDelivery>(collection)) {
          if (record.status === "sending") this.store.put(collection, record.id, { ...record, status: "unknown" });
        }
      }
    });
  }
  commitDelivery(selection: DeliverySelection, id: string, status: DeliveryOutcome, receipt?: ChannelDeliveryReceipt): void {
    this.store.transaction(() => {
      const collection = deliveryCollection(selection), current = this.store.get<GatewayDelivery | ChannelReply | LegacyDelivery>(collection, id);
      if (!current) return;
      if ("sessionId" in current && current.sessionId && !this.session(current.sessionId)) return;
      if (status === "sending" && current.status !== "pending" || status !== "sending" && current.status !== "sending") throw new Error("投递状态已经变化。");
      this.store.put(collection, id, { ...current, status, ...(receipt?.messageId ? { [selection === "current" ? "platformMessageId" : "messageId"]: receipt.messageId } : {}) });
      if (status === "sent" && receipt?.messageId && "sessionId" in current && current.sessionId) {
        const entry = "entry" in current ? current.entry : "input" in current ? current.input : undefined;
        if (entry) {
          const message = "messageId" in current && selection === "current" ? this.store.get<GatewayMessage>("messages", current.messageId!) : undefined;
          this.registerPlatformMessage(entry, receipt.messageId, { sessionId: current.sessionId, ...(message?.agentId ? { agentId: message.agentId } : {}) });
        }
      }
    });
  }
  failDelivery(selection: "current" | "legacy", id: string, detail: string): void {
    const collection = deliveryCollection(selection), current = this.store.get<GatewayDelivery | LegacyDelivery>(collection, id);
    if (!current) return;
    if (current.status !== "pending") throw new Error("只有等待发送的投递能够记录准备失败。");
    this.store.put(collection, id, { ...current, status: "failed", detail });
  }
  suppressLegacyDelivery(id: string): void {
    const current = this.legacyDelivery(id);
    if (!current) return;
    if (current.status !== "pending") throw new Error("只有等待发送的投递能够取消发送。");
    this.store.put("legacy-deliveries", id, { ...current, status: "suppressed" });
  }
  retryDelivery(id: string, confirmUnknown: boolean): GatewayDelivery | ChannelReply {
    const delivery = this.delivery(id), current = delivery ?? this.reply(id);
    if (!current) throw new Error("消息投递记录不存在。");
    assertRetry(current.status, confirmUnknown);
    const pending = { ...current, status: "pending" as const };
    this.store.put(delivery ? "deliveries" : "channel-replies", id, pending);
    return pending;
  }
  retryLegacyDelivery(id: string, confirmUnknown: boolean): LegacyDelivery {
    const current = this.legacyDelivery(id);
    if (!current) throw new Error("历史投递记录不存在。");
    assertRetry(current.status, confirmUnknown);
    const pending = { ...current, status: "pending" as const };
    this.store.put("legacy-deliveries", id, pending);
    return pending;
  }
  recordMessageChange(input: ChannelInput, originalState: PendingInput["state"], sessionId: string | undefined,
    createNotice: (session: GatewaySession, change: ChannelMessageChange) => string): void {
    this.store.transaction(() => {
      const id = `${inboxId(input)}:change`, previous = this.store.get<ChannelMessageChange>("message-changes", id);
      if (previous && digest(previous.input) !== digest(input)) throw new Error("平台消息变更事件 ID 内容冲突。");
      if (previous?.sessionId && sessionId && previous.sessionId !== sessionId) throw new Error("平台消息变更的会话关联发生冲突。");
      if (previous?.noticeId) return;
      const change: ChannelMessageChange = { ...previous, id, input, originalState: previous?.originalState ?? originalState, ...(sessionId ? { sessionId } : {}) };
      const session = change.sessionId ? this.session(change.sessionId) : undefined;
      if (session && !["pending", "deleted"].includes(change.originalState)) change.noticeId = createNotice(session, change);
      this.store.put("message-changes", id, change);
    });
  }
  deleteSession(sessionId: string): void {
    this.store.transaction(() => {
      const inputs = new Set<string>();
      const receipts = this.store.entries<{ fingerprint: string; sessionId?: string; result?: GatewayReceipt }>("receipts");
      const receiptIds = new Set(receipts.filter(({ value }) => value.sessionId === sessionId || value.result?.sessionId === sessionId).map(({ id }) => id));
      for (const record of this.inputs()) {
        const input = record.input;
        const actor = { kind: "platform" as const, account: input.account, conversation: input.conversation, userId: input.sender };
        const receiptId = digest({ actor: actorKey(actor), requestId: `channel:${record.id}` });
        const associated = input.messageId ? this.platformMessage(input, input.messageId) : undefined;
        if (record.sessionId === sessionId || receiptIds.has(receiptId) || associated?.sessionId === sessionId) inputs.add(record.id);
      }
      for (const collection of ["inbox", "channel-replies", "message-changes"]) {
        for (const { id, value } of this.store.entries<{ sessionId?: string; input: ChannelInput }>(collection)) {
          if (value.sessionId === sessionId || inputs.has(inboxId(value.input))) this.store.delete(collection, id);
        }
      }
      for (const { id, value } of receipts) if (receiptIds.has(id)) this.store.put("receipts", id, { id, fingerprint: value.fingerprint, error: "原请求所属会话已删除。" });
      for (const graph of this.store.list<{ id: string; sessionId: string }>("graphs")) if (graph.sessionId === sessionId) this.store.delete("coordination", graph.id);
      for (const collection of ["bindings", "messages", "tasks", "deliveries", "approvals", "events", "graphs", "platform-messages", "steering", "defaults"]) {
        for (const { id, value } of this.store.entries<{ sessionId: string }>(collection)) if (value.sessionId === sessionId) this.store.delete(collection, id);
      }
      this.store.delete("sequences", sessionId);
      this.store.delete("sessions", sessionId);
    });
  }
}

function deliveryCollection(selection: DeliverySelection): "deliveries" | "channel-replies" | "legacy-deliveries" {
  return selection === "current" ? "deliveries" : selection === "reply" ? "channel-replies" : "legacy-deliveries";
}
function sameMessage(left: ChannelInput, right: ChannelInput): boolean {
  return left.account === right.account && left.conversation === right.conversation && (left.threadId ?? null) === (right.threadId ?? null) && left.messageId === right.messageId;
}
function assertRetry(status: string, confirmUnknown: boolean): void {
  if (status === "sending" || status === "sent") throw new Error("该消息正在发送或已经发送。");
  if (status === "unknown" && !confirmUnknown) throw new Error("发送结果未知，确认可能重复后才能重新发送。");
}
