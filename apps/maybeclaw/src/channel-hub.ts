import { ChannelStore, inboxId, type ChannelInput, type DeliveryRecord, type InboxRecord } from "./channel-store.js";
import type { ChannelAdapter } from "./channels.js";
import type { MaybeClaw } from "./service.js";
import { digest, isTerminal, taskId, type TaskSnapshot } from "./types.js";

export type SubmitTask = (prompt: string, requestId: string) => Promise<{ task: TaskSnapshot; created: boolean }>;
const HELP = "MaybeClaw：发送文本创建独立任务（无跨消息记忆）。\n/status <完整任务 ID>\n/result <完整任务 ID>\n/cancel <完整任务 ID>\n仅能操作由你在当前私聊创建的任务。";

export class ChannelHub {
  private ingress: Promise<void> = Promise.resolve();
  readonly processingErrors = new Map<string, string>();
  constructor(readonly store: ChannelStore, readonly adapters: readonly ChannelAdapter[], private readonly claw: MaybeClaw, private readonly submit: SubmitTask) {}
  receive(input: ChannelInput): Promise<void> {
    const operation = this.ingress.then(async () => {
      const adapter = this.adapters.find((v) => v.account === input.account);
      if (!adapter?.allowUsers.includes(input.sender)) return;
      const id = inboxId(input);
      const prior = this.store.get(id);
      if (prior) {
        if (prior.kind !== "inbox" || digest(prior.input) !== digest(input)) throw new Error("Channel event identity conflict");
        return;
      }
      if (this.store.values().filter((v) => v.kind === "inbox" && !v.processed).length >= 100) throw new Error("Inbox is full");
      await this.store.put({ kind: "inbox", id, input, processed: false });
    });
    this.ingress = operation.catch(() => {});
    return operation;
  }
  async process(): Promise<void> {
    for (const value of this.store.values()) {
      if (value.kind !== "inbox") continue;
      const adapter = this.adapters.find((a) => a.account === value.input.account);
      if (!adapter?.allowUsers.includes(value.input.sender)) continue;
      if (this.processingErrors.has(value.id)) continue;
      try {
        if (!value.processed) await this.processInput(value);
        else if (value.taskId && !value.terminalNotified) {
          const task = await this.claw.store.inspect(value.taskId);
          if (task && (isTerminal(task) || task.status === "blocked")) {
            await this.reply(value, "terminal", describe(task));
            await this.store.put({ ...value, terminalNotified: true });
          }
        }
      } catch { this.processingErrors.set(value.id, "Inbox processing failed; check configuration/storage and restart. The original event identity is retained."); }
    }
  }
  private async processInput(record: InboxRecord): Promise<void> {
    const text = record.input.text.trim();
    if (text.startsWith("/")) {
      const command = /^\/(status|result|cancel)\s+([a-f0-9]{64})$/.exec(text);
      let response = HELP;
      if (command) {
        const id = command[2]!;
        const owned = this.store.values().some((v) => v.kind === "inbox" && v.taskId === id && sameOwner(v.input, record.input));
        if (!owned) response = "任务不存在或不属于当前私聊。";
        else {
          const task = command[1] === "cancel" ? (await this.claw.cancel(id)).task : (await this.claw.status(id)).task;
          response = describe(task, command[1] === "result");
        }
      }
      await this.reply(record, "accepted", response);
      await this.store.put({ ...record, processed: true });
      return;
    }
    const requestId = `channel:${record.id}`;
    // Crash after submit but before inbox projection: preserve the original pinned spec.
    const existing = await this.claw.store.inspect(taskId(requestId));
    const task = existing ?? (await this.submit(record.input.text, requestId)).task;
    const accepted = { ...record, taskId: task.id };
    await this.reply(accepted, "accepted", `已接收任务\n${task.id}\n状态：${task.status}\n结果会在完成后回传。`);
    await this.store.put({ ...accepted, processed: true });
  }
  private async reply(record: InboxRecord, purpose: string, text: string): Promise<void> {
    const id = digest({ inbox: record.id, purpose });
    if (this.store.get(id)) return;
    // One bounded plain-text message; full output stays in the authenticated Web UI.
    const bounded = text.length <= 3900 ? text : text.slice(0, 3800) + "\n…结果已截断，请在 Web UI 查看完整内容。";
    await this.store.put({ kind: "delivery", id, account: record.input.account, sender: record.input.sender,
      conversation: record.input.conversation, text: bounded, status: "pending", ...(record.taskId ? { taskId: record.taskId } : {}) });
  }
  async deliver(signal: AbortSignal): Promise<void> {
    for (const record of this.store.values()) {
      if (signal.aborted) return;
      if (record.kind !== "delivery" || record.status !== "pending") continue;
      const adapter = this.adapters.find((v) => v.account === record.account);
      if (!adapter) continue; // Never deliver through a different bot after credential changes.
      if (!adapter.allowUsers.includes(record.sender)) { await this.store.put({ ...record, status: "suppressed" }); continue; }
      if (!["polling", "connected"].includes(adapter.status())) continue;
      await this.store.put({ ...record, status: "sending" });
      let status: DeliveryRecord["status"] = "sent";
      try { await adapter.send(record, signal); } catch { status = "unknown"; }
      await this.store.put({ ...record, status });
    }
  }
  async close(): Promise<void> { await this.ingress; }
}
function sameOwner(a: ChannelInput, b: ChannelInput): boolean { return a.account === b.account && a.sender === b.sender && a.conversation === b.conversation; }
function describe(task: TaskSnapshot, includeResult = true): string {
  return `任务 ${task.id}\n状态：${task.status}\n验证：${task.verification}${includeResult && task.result ? `\n\n${task.result}` : ""}${task.detail ? `\n${task.detail}` : ""}`;
}
