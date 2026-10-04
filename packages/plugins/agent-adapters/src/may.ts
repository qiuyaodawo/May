import type { AgentDefinition, AgentApplication } from "@may/application";
import type { SessionStore } from "@may/session";
import { digest } from "@may/plugin-delivery";
import type { AgentAdapter, AgentAdapterContext } from "./types.js";

export interface MayAgentAdapterOptions {
  readonly agentId: string;
  readonly store: SessionStore;
  readonly definition: (tools: () => AgentAdapterContext["tools"], context: () => AgentAdapterContext | undefined) => AgentDefinition | Promise<AgentDefinition>;
  readonly media?: readonly string[];
  readonly metadata?: (conversationId: string) => Record<string, unknown>;
}
export function createMayAgentAdapter(options: MayAgentAdapterOptions): AgentAdapter {
  const store = options.store;
  const opened = new Map<string, { app: AgentApplication; context?: AgentAdapterContext; relay: Promise<void> }>();
  const opening = new Map<string, Promise<AgentApplication>>();
  let closed = false, closing: Promise<void> | undefined;
  const historyOf = (id: string) => store.inspect ? store.inspect(id) : store.read(id);
  async function open(id: string): Promise<AgentApplication> {
    if (closed) throw new Error("Agent adapter is closed");
    if (opened.has(id)) return opened.get(id)!.app;
    const pending = opening.get(id);
    if (pending) return pending;
    const work = (async () => {
      const source = () => opened.get(id)?.context?.tools ?? [];
      const definition = await options.definition(source, () => opened.get(id)?.context);
      const history = await historyOf(id);
      const metadata = options.metadata?.(id);
      const app = await definition.open({ store, sessionId: id, resume: history.length > 0, ...(metadata === undefined ? {} : { metadata }) });
      if (closed) { await app.close(); throw new Error("Agent adapter closed during conversation creation"); }
      const record: { app: AgentApplication; context?: AgentAdapterContext; relay: Promise<void> } = { app, relay: Promise.resolve() };
      opened.set(id, record);
      record.relay = (async () => { for await (const event of app.events) record.context?.report(event); })();
      void record.relay.catch(() => app.cancel("Agent event persistence failed"));
      return app;
    })();
    opening.set(id, work);
    try { return await work; } finally { opening.delete(id); }
  }
  return {
    capabilities: { cancel: true, steer: true, resume: true, delete: store.delete !== undefined, approvals: true, collaboration: true, media: [...(options.media ?? [])] },
    async createConversation(requestId) {
      const id = digest({ agent: options.agentId, requestId });
      await open(id); return id;
    },
    async inspectCreation(requestId) {
      const id = digest({ agent: options.agentId, requestId });
      return (await historyOf(id)).length ? { status: "ready", conversationId: id } : { status: "not-started" };
    },
    async execute(context) {
      const app = await open(context.conversationId), record = opened.get(context.conversationId)!;
      if (record.context || app.isRunning) throw new Error("Agent 对话正在执行。");
      const prior = await this.inspect(context.conversationId, context.inputId);
      if (prior.status !== "not-started") throw new Error("该输入已经提交，请查询原执行结果。");
      record.context = context;
      try {
        const run = await app.submit({ input: context.input, inputId: context.inputId, signal: context.signal, shouldYield: context.shouldYield });
        const result = await run.result;
        return { text: result.message.content.filter(part => part.type === "text").map(part => part.text).join(""),
          runId: result.runId, content: result.message.content.filter(part => part.type !== "reasoning"), ...(result.finishReason === "yielded" ? { yielded: true } : {}) };
      } finally { delete record.context; }
    },
    async inspect(conversationId, inputId) {
      const history = await historyOf(conversationId);
      const start = history.findIndex(event => event.type === "input.submitted" && event.inputId === inputId);
      if (start < 0) return { status: "not-started" };
      const end = history.findIndex((event, index) => index > start && event.type === "input.submitted");
      const segment = history.slice(start + 1, end < 0 ? undefined : end);
      const unresolved = new Set<string>(), approvals = new Map<string, string>();
      for (const event of segment) {
        if (event.type === "tool.started") unresolved.add(`${event.runId}:${event.step}:${event.call.id}`);
        if (event.type === "tool.completed") unresolved.delete(`${event.runId}:${event.step}:${event.call.id}`);
        if (event.type === "tool.failed" && !/CANCEL|ABORT|UNKNOWN/i.test(`${event.error.code} ${event.error.name}`)) unresolved.delete(`${event.runId}:${event.step}:${event.call.id}`);
        if (event.type === "run.interrupted") for (const item of event.recoveries) if (item.status === "unknown") unresolved.add(item.id);
        if (event.type === "recovery.resolved") unresolved.delete(event.recoveryId);
        if (event.type === "approval.requested") approvals.set(event.request.id, `${event.request.runId}:${event.request.step}:${event.request.toolCallId}`);
        if (event.type === "approval.cancelled") { const key = approvals.get(event.requestId); if (key) unresolved.delete(key); approvals.delete(event.requestId); }
        if (event.type === "approval.resolved") approvals.delete(event.requestId);
      }
      if (unresolved.size) return { status: "recovery-required", detail: "工具结果需要核对。" };
      const terminal = [...segment].reverse().find(event => ["run.completed", "run.yielded", "run.cancelled", "run.failed"].includes(event.type));
      if (terminal?.type === "run.completed") return { status: "completed", text: terminal.result.message.content.filter(part => part.type === "text").map(part => part.text).join(""), runId: terminal.result.runId, content: terminal.result.message.content.filter(part => part.type !== "reasoning") };
      if (terminal?.type === "run.yielded") return { status: "waiting" };
      if (terminal?.type === "run.cancelled") return { status: "cancelled" };
      if (terminal?.type === "run.failed") return { status: "failed", detail: terminal.error.message };
      if (segment.some(event => event.type === "run.interrupted")) return { status: "failed", detail: "执行已经中断，工具结果已核对。请通过新输入继续。" };
      return { status: "recovery-required", detail: "输入已保存，尚无可靠执行结果。" };
    },
    async cancel(id) { opened.get(id)?.app.cancel(); },
    async steer(id, text, inputId) { return (await open(id)).steer({ input: text, inputId }); },
    async steeringInputs(id) {
      return (await open(id)).listSteeringInputs().map(input => ({ inputId: input.inputId, text: input.message.content.filter(part => part.type === "text").map(part => part.text).join(""), status: input.status }));
    },
    async resolveApproval(id, requestId, decision, persistentOptions) { return await opened.get(id)?.app.resolveApproval(requestId, decision, persistentOptions) ?? false; },
    async release(id) {
      const pending = opening.get(id); if (pending) await pending;
      const item = opened.get(id); if (!item) return;
      if (item.context || item.app.isRunning) throw new Error("活动 Agent 对话不能释放。");
      await item.app.close(); await item.relay; opened.delete(id);
    },
    async deleteConversation(id) {
      if (!store.delete) throw new Error("Session storage does not support deletion");
      await this.release!(id); await store.delete(id);
    },
    async command(id, name, args) {
      const app = await open(id);
      if (name === "recovery" && args.length === 0) return JSON.stringify(app.listRecoveries(), null, 2);
      if (name === "resolve-recovery" && args.length >= 2) { await app.resolveRecovery(args[0]!, args.slice(1).join(" ")); return "已记录工具结果核对结论。"; }
      throw new Error("May Agent 命令：recovery；resolve-recovery <ID> <已经核实的结论>。");
    },
    close() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await Promise.allSettled(opening.values());
        const results = await Promise.allSettled([...opened.values()].map(async item => { await item.app.close(); await item.relay; }));
        opened.clear();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "Agent conversations failed to close");
      })();
    },
  };
}
