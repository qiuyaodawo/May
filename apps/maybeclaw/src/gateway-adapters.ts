import { mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentDefinition, defineAgent, type AgentApplication } from "@may/application";
import { loadMayConfig } from "@may/config";
import { createReadTool } from "@may/coding-tools";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import { digest } from "./types.js";
import type { GatewayAgentAdapter, GatewayAgentConfig, GatewayAdapterContext } from "./gateway-types.js";

export interface MayAdapterOptions {
  directory: string;
  configPath: string;
  agent: GatewayAgentConfig;
  definition?: (tools: () => GatewayAdapterContext["tools"]) => Promise<AgentDefinition> | AgentDefinition;
}

export async function loadGatewayAdapter(options: MayAdapterOptions): Promise<GatewayAgentAdapter> {
  if (options.agent.adapter === "may") {
    if (!options.definition) {
      const config = await loadMayConfig({ path: options.configPath });
      createBuiltinProviderModel(selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {}));
    }
    return createMayAdapter(options);
  }
  const specifier = options.agent.module!;
  const module = await import(isAbsolute(specifier) || specifier.startsWith(".")
    ? pathToFileURL(resolve(specifier)).href : specifier);
  const factory: unknown = module[options.agent.export ?? "createAdapter"];
  if (typeof factory !== "function") throw new Error(`Agent ${options.agent.id} 的模块没有导出 createAdapter。`);
  const adapter: GatewayAgentAdapter = await factory({ ...options, options: options.agent.options ?? {} });
  if (!adapter || !adapter.capabilities || ["createConversation", "execute", "inspect", "close"].some(key => typeof adapter[key as keyof GatewayAgentAdapter] !== "function")) {
    throw new Error(`Agent ${options.agent.id} 的适配器接口不完整。`);
  }
  if (["cancel", "steer", "resume", "delete", "approvals", "collaboration"].some(key => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== "boolean")
    || !Array.isArray(adapter.capabilities.media) || adapter.capabilities.media.some(value => !["image", "audio", "file", "video"].includes(value))) throw new Error(`Agent ${options.agent.id} 的能力声明不合法。`);
  for (const [flag, method] of [["cancel", "cancel"], ["steer", "steer"], ["steer", "steeringInputs"], ["delete", "deleteConversation"], ["approvals", "resolveApproval"]] as const) {
    if (adapter.capabilities[flag] && typeof adapter[method] !== "function") throw new Error(`Agent ${options.agent.id} 缺少 ${method}。`);
  }
  return adapter;
}

export function createMayAdapter(options: MayAdapterOptions): GatewayAgentAdapter {
  const store = new FileSessionStore(join(options.directory, "agents", options.agent.id, "sessions"));
  const opened = new Map<string, { app: AgentApplication; context?: GatewayAdapterContext; relay: Promise<void> }>();
  const opening = new Map<string, Promise<AgentApplication>>();
  async function open(id: string): Promise<AgentApplication> {
    if (opened.has(id)) return opened.get(id)!.app;
    const pending = opening.get(id);
    if (pending) return pending;
    const work = (async () => {
      let tools: GatewayAdapterContext["tools"] = [];
      const source = () => opened.get(id)?.context?.tools ?? tools;
      const config = await loadMayConfig({ path: options.configPath });
      const definition = options.definition ? await options.definition(source) : defineAgent({
        model: createBuiltinProviderModel(selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {})),
        ...(options.agent.instructions === undefined ? {} : { instructions: options.agent.instructions }),
        tools: options.agent.readDirectory ? [createReadTool({ cwd: options.agent.readDirectory })] : [],
        toolSource: source,
        permissionPolicy: check => options.agent.permissions?.[check.tool.name]
          ?? (["list_agents", "delegate_tasks", "send_message", "wait_for_messages", "handoff_task", "read"].includes(check.tool.name) ? "allow" : "ask"),
        ...(options.agent.runBudget ? { runBudget: options.agent.runBudget } : {}),
      });
      const history = await store.inspect(id);
      const app = await definition.open({ store, sessionId: id, resume: history.length > 0,
        metadata: { maybeclaw: { agentId: options.agent.id, conversationId: id } } });
      const record: { app: AgentApplication; context?: GatewayAdapterContext; relay: Promise<void> } = { app, relay: Promise.resolve() };
      opened.set(id, record);
      record.relay = (async () => { for await (const event of app.events) record.context?.report(event); })();
      void record.relay.catch(() => app.cancel("Gateway event persistence failed"));
      return app;
    })();
    opening.set(id, work);
    try { return await work; } finally { opening.delete(id); }
  }
  return {
    capabilities: { cancel: true, steer: true, resume: true, delete: true, approvals: true, collaboration: true, media: options.agent.media ?? [] },
    async createConversation(requestId) {
      const id = digest({ agent: options.agent.id, requestId });
      await mkdir(join(options.directory, "agents", options.agent.id), { recursive: true });
      await open(id);
      return id;
    },
    async inspectCreation(requestId) {
      const id = digest({ agent: options.agent.id, requestId });
      return (await store.inspect(id)).length ? { status: "ready", conversationId: id } : { status: "not-started" };
    },
    async execute(context) {
      const app = await open(context.conversationId);
      const record = opened.get(context.conversationId)!;
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
      const history = await store.inspect(conversationId);
      const start = history.findIndex(event => event.type === "input.submitted" && event.inputId === inputId);
      if (start < 0) return { status: "not-started" };
      const end = history.findIndex((event, index) => index > start && event.type === "input.submitted");
      const segment = history.slice(start + 1, end < 0 ? undefined : end);
      const unresolved = new Set<string>();
      const approvals = new Map<string, string>();
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
    async steer(id, text, inputId) {
      const app = await open(id);
      return app.steer({ input: text, inputId });
    },
    async steeringInputs(id) {
      const app = await open(id);
      return app.listSteeringInputs().map(input => ({ inputId: input.inputId, text: input.message.content.filter(part => part.type === "text").map(part => part.text).join(""), status: input.status }));
    },
    async resolveApproval(id, requestId, decision) { return await opened.get(id)?.app.resolveApproval(requestId, decision) ?? false; },
    async release(id) {
      const item = opened.get(id);
      if (!item) return;
      if (item.context || item.app.isRunning) throw new Error("活动 Agent 对话不能释放。");
      await item.app.close(); await item.relay; opened.delete(id);
    },
    async deleteConversation(id) { await this.release!(id); await store.delete(id); },
    async command(id, name, args) {
      const app = await open(id);
      if (name === "recovery" && args.length === 0) return JSON.stringify(app.listRecoveries(), null, 2);
      if (name === "resolve-recovery" && args.length >= 2) {
        await app.resolveRecovery(args[0]!, args.slice(1).join(" "));
        return "已记录工具结果核对结论。使用 task recover 查询原任务状态，再发送新输入继续。";
      }
      throw new Error("May Agent 命令：recovery；resolve-recovery <ID> <已经核实的结论>。");
    },
    async close() {
      for (const id of opened.keys()) {
        const item = opened.get(id)!;
        await item.app.close(); await item.relay; opened.delete(id);
      }
    },
  };
}
