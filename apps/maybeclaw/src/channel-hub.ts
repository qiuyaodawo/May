import { ChannelStore, inboxId, type ChannelInput, type DeliveryRecord, type InboxRecord } from "./channel-store.js";
import type { ChannelAdapter } from "./channels.js";
import type { MaybeClaw } from "./service.js";
import { digest, isTerminal, taskId, type TaskSnapshot } from "./types.js";
import { imageAttachment, readEmbeddedImage, type MediaReader } from "@may/media";
import { UiProjection } from "@may/ui-client/projection";

export type SubmitTask = (prompt: string, requestId: string) => Promise<{ task: TaskSnapshot; created: boolean }>;
const HELP = "MaybeClaw：发送文本创建独立任务（无跨消息记忆）。\n/status <完整任务 ID>\n/result <完整任务 ID>\n/cancel <完整任务 ID>\n仅能操作由你在当前私聊创建的任务。";

export class ChannelHub {
  private ingress: Promise<void> = Promise.resolve();
  readonly processingErrors = new Map<string, string>();
  constructor(readonly store: ChannelStore, readonly adapters: readonly ChannelAdapter[], private readonly claw: MaybeClaw, private readonly submit: SubmitTask, private readonly readMedia: MediaReader = readEmbeddedImage) {}
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
            await this.replyResult(value, "terminal", task);
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
          if (command[1] === "result" && task.status === "completed") {
            await this.replyResult({ ...record, taskId: task.id }, "accepted", task);
            await this.store.put({ ...record, processed: true });
            return;
          }
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
  private async replyResult(record: InboxRecord, purpose: string, task: TaskSnapshot): Promise<void> {
    const history = task.status === "completed" ? await this.claw.readSessionHistory(task.id) : [];
    const replies = history.filter(event => event.type === "assistant.completed");
    if (!replies.some(event => event.message.content.some(part => part.type === "image"))) { await this.reply(record, purpose, describe(task)); return; }
    const adapter = this.adapters.find(value => value.account === record.input.account);
    const parts: Array<{ text: string; imageId?: string }> = [{ text: describe(task, false) }];
    for (const reply of replies) for (const part of reply.message.content) {
      if (part.type === "text") {
        for (let offset = 0; offset < part.text.length; offset += 3800) parts.push({ text: part.text.slice(offset, offset + 3800) });
      } else if (part.type === "image") {
        const image = imageAttachment(part.source);
        if ((part.source.type === "base64" || this.readMedia !== readEmbeddedImage) && adapter?.media?.images) parts.push({ text: `图片 ${image.id}`, imageId: image.id });
        else parts.push({ text: image.url ? `图片链接：${image.url}` : `图片 ${image.id}：请在 Web UI 查看。` });
      }
    }
    let after: string | undefined;
    for (const [index, part] of parts.entries()) {
      const id = digest({ inbox: record.id, purpose, part: index });
      if (!this.store.get(id)) await this.store.put({ kind: "delivery", id, account: record.input.account, sender: record.input.sender,
        conversation: record.input.conversation, taskId: task.id, ...part, ...(after ? { after } : {}), status: "pending" });
      after = id;
    }
  }
  async deliver(signal: AbortSignal): Promise<void> {
    for (const record of this.store.values()) {
      if (signal.aborted) return;
      if (record.kind !== "delivery" || record.status !== "pending") continue;
      if (record.after) { const previous = this.store.get(record.after); if (previous?.kind !== "delivery" || previous.status !== "sent") continue; }
      const adapter = this.adapters.find((v) => v.account === record.account);
      if (!adapter) continue; // Never deliver through a different bot after credential changes.
      if (!adapter.allowUsers.includes(record.sender)) { await this.store.put({ ...record, status: "suppressed" }); continue; }
      if (!["polling", "connected"].includes(adapter.status())) continue;
      let image;
      if (record.imageId) {
        const projection = new UiProjection(Infinity); projection.history(await this.claw.readSessionHistory(record.taskId!));
        const source = projection.mediaSources.get(record.imageId);
        if (!source) throw new Error("Delivery image is absent from task history");
        image = await this.readMedia(source, signal);
      }
      await this.store.put({ ...record, status: "sending" });
      let status: DeliveryRecord["status"] = "sent";
      try { await adapter.send(record, signal, image); } catch { status = "unknown"; }
      await this.store.put({ ...record, status });
    }
  }
  async close(): Promise<void> { await this.ingress; }
}
function sameOwner(a: ChannelInput, b: ChannelInput): boolean { return a.account === b.account && a.sender === b.sender && a.conversation === b.conversation; }
function describe(task: TaskSnapshot, includeResult = true): string {
  return `任务 ${task.id}\n状态：${task.status}\n验证：${task.verification}${includeResult && task.result ? `\n\n${task.result}` : ""}${task.detail ? `\n${task.detail}` : ""}`;
}
