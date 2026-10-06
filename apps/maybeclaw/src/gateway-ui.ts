import { randomUUID } from "node:crypto";
import { quote } from "shell-quote";
import { commandArgs, createTelemetryPanel, UiError, type UiTelemetryData, type UiAction, type UiBlock, type UiCommand, type UiFieldRequest, type UiHost, type UiPageRequest, type UiReceipt, type UiSnapshot } from "@may/ui-client";
import { historyPage, readPage, fieldPage } from "@may/ui-client/reading";
import { UiProjection } from "@may/ui-client/projection";
import { displayParts, imageAttachment, readEmbeddedImage } from "@may/media";
import type { AgentApplicationEvent } from "@may/application";
import type { ApprovalDecision } from "@may/permissions";
import type { AgentGateway } from "./gateway.js";
import type { GatewayActor, GatewayAgentConfig, GatewayApproval, GatewayBinding, GatewayDelivery, GatewayEntry, GatewaySession, GatewayTask } from "./gateway-types.js";
import { actorKey } from "./gateway-types.js";
import type { LegacyTaskRecord } from "./gateway-migration.js";
import { digest } from "./types.js";

export const controlActor: GatewayActor = { kind: "operator", id: "control" };

export class GatewayUiHost implements UiHost {
  readonly hostId = randomUUID();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  constructor(readonly gateway: AgentGateway, private readonly hostStatus: () => unknown = () => gateway.status(), private readonly retryLegacyDelivery?: (id: string, confirmUnknown: boolean) => unknown) {
    this.unsubscribe = gateway.observe(() => { this.revision++; for (const listener of this.listeners) listener(); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.unsubscribe(); this.listeners.clear(); }

  async snapshot(selectedId?: string, all = false): Promise<UiSnapshot> {
    const legacy = selectedId?.startsWith("legacy:") ? this.gateway.store.get<LegacyTaskRecord>("legacy-tasks", selectedId.slice(7)) : undefined;
    if (selectedId?.startsWith("legacy:") && !legacy) throw new UiError(404, "历史任务不存在。");
    const session = selectedId && !legacy ? this.gateway.session(selectedId, controlActor) : undefined;
    const tasks = this.gateway.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session?.id);
    const approvals = this.gateway.store.list<GatewayApproval>("approvals").filter(item => item.sessionId === session?.id);
    const blocks = legacy ? this.legacyBlocks(legacy) : session ? this.blocks(session) : [];
    const page = historyPage(this.hostId, selectedId ?? "", blocks);
    const resources = this.resourceList();
    const commands = ["session.new", "session.create", "session.activate", "gateway.command", "gateway.inspect", "agent.save", "agent.delete", "agent.check", "approval.resolve", "delivery.retry"];
    if (this.gateway.options.settings.persistentRules) commands.push("permission.rule.create", "permission.rule.revoke");
    if (session) commands.push("session.rename", "session.archive", "session.restore", "session.delete", "session.default", "session.bind", "session.admins", "agent.default", "agent.allow", "session.diagnostics");
    if (session?.status === "active") commands.push("message.submit", "run.cancel");
    return {
      version: 1, hostId: this.hostId, revision: ++this.revision,
      product: { id: "maybeclaw", title: "MaybeClaw", resourceKind: "session", subtitle: "管理会话，并通过 Gateway 使用与协作多个 Agent。", suggestions: [] },
      resources: resources.slice(0, 500), resourcesVersion: digest(resources), selectedId: selectedId ?? null,
      blocks: all ? blocks : page.items, historyPage: { nextCursor: page.nextCursor, total: page.total },
      reads: { resources: true, history: true, fields: true }, commands, choices: [],
      controls: { inputCommand: "gateway.command", responseCommand: "approval.resolve", cancelCommand: "run.cancel", busy: false, forms: [] },
      interactions: approvals.filter(item => item.status === "pending" && item.expiresAt > Date.now()).map(item => ({
        id: item.id, kind: "approval", title: `${item.agentId} · ${item.kind === "tool" ? "工具审批" : "创建 Agent 对话"}`, detail: item.text,
        blockId: `approval:${item.id}`, runId: item.taskId ?? "", toolCallId: item.requestId, toolName: item.agentId,
        choices: [{ value: "allow", label: "允许本次" }, ...(item.grantKey ? [{ value: "allow-session", label: "允许该 Agent 对话中的同类操作" }] : []), ...(item.persistent && this.gateway.options.settings.persistentRules ? [{ value: "allow-persistent", label: "保存持久允许规则" }] : []), { value: "deny", label: "拒绝" }],
      })),
      panels: [
        { id: "agents", title: "已配置 Agent", fields: this.gateway.status().agents.map(agent => ({ label: agent.id, value: `${agent.name} · ${agent.status}` })) },
        ...(session ? [{ id: "session", title: "会话", fields: [
          { label: "会话 ID", value: session.id }, { label: "状态", value: session.status },
          { label: "默认 Agent", value: session.defaultAgents.join(", ") }, { label: "可用 Agent", value: session.allowedAgents.join(", ") },
          { label: "聊天入口", value: session.entry ? JSON.stringify(session.entry) : "控制端会话" },
          ...this.gateway.store.list<GatewayBinding>("bindings").filter(binding => binding.sessionId === session.id).map(binding => ({ label: binding.agentId, value: `${binding.status} · ${binding.conversationId ?? binding.error ?? "尚无对话 ID"}` })),
        ] }] : []),
        { id: "tasks", title: "执行", fields: tasks.map(task => ({ label: `${task.agentId} · ${task.id}`, value: `${task.status} · graph ${task.graphId} · task ${task.graphTaskId}${task.detail ? ` · ${task.detail}` : ""}` })) },
        ...(session ? [{ id: "telemetry", title: "执行诊断", fields: [], actions: [{ label: "查询当前会话", command: "session.diagnostics", args: {} }] }] : []),
        { id: "deliveries", title: "消息投递", fields: this.gateway.store.list<GatewayDelivery>("deliveries").filter(item => item.sessionId === session?.id).map(item => ({ label: `${item.entry.account} · ${item.id}`, value: item.status })) },
        { id: "host", title: "服务状态", fields: [{ label: "Gateway", value: JSON.stringify(this.hostStatus(), null, 2) }] },
        ...(this.gateway.options.settings.persistentRules ? [{ id: "permission-rules", title: "持久权限规则", fields: [],
          actions: [{ label: "查看和管理规则", command: "gateway.inspect", args: { kind: "permission-rules" } }] }] : []),
      ],
      notice: "浏览页面只改变当前窗口。入口默认会话通过会话管理中的明确操作修改。",
    };
  }

  private resourceList() {
    return [
      ...this.gateway.sessions(controlActor).map(session => ({ id: session.id, kind: "session" as const, title: session.name, status: session.status, updatedAt: session.updatedAt })),
      ...this.gateway.store.list<LegacyTaskRecord>("legacy-tasks").map(task => ({ id: `legacy:${task.id}`, kind: "task" as const, title: `历史任务 · ${task.snapshot.spec.prompt.slice(0, 64)}`, status: task.status, updatedAt: task.snapshot.updatedAt })),
    ].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  private blocks(session: GatewaySession): UiBlock[] {
    const times = new Map<string, number>();
    const messages: UiBlock[] = this.gateway.messages(session.id, controlActor).map(message => ({
      id: message.id, kind: message.kind, text: message.text,
      ...(message.content ? { content: displayParts(message.content) } : {}),
      title: `${message.agentId ?? (message.actor?.kind === "operator" ? "服务管理员" : message.actor?.kind === "platform" ? actorKey(message.actor) : "MaybeClaw")}${message.taskId ? ` · ${message.taskId.slice(0, 8)}` : ""}`,
      ...(message.taskId ? { runId: message.taskId } : {}),
    }));
    for (const message of this.gateway.messages(session.id, controlActor)) times.set(message.id, message.createdAt);
    const projection = new UiProjection(Infinity);
    for (const item of this.gateway.store.list<{ sessionId: string; event: AgentApplicationEvent; at: number }>("events")) if (item.sessionId === session.id) {
      projection.event(item.event);
      if (item.event.type === "run.event" && "call" in item.event.event) {
        const id = `tool:${item.event.event.runId}:${item.event.event.call.id}`; if (!times.has(id)) times.set(id, item.at);
      }
    }
    messages.push(...[...projection.blocks.values()].filter(block => block.kind === "tool"));
    for (const approval of this.gateway.store.list<GatewayApproval>("approvals").filter(item => item.sessionId === session.id)) messages.push({
      id: `approval:${approval.id}`, kind: "notice", text: approval.text, title: `${approval.agentId} · 审批`,
      approval: { id: approval.id, status: ["expired", "unknown", "resolving"].includes(approval.status) ? "cancelled" : approval.status as "pending" | "allowed" | "denied" | "cancelled" },
    });
    for (const approval of this.gateway.store.list<GatewayApproval>("approvals")) times.set(`approval:${approval.id}`, approval.createdAt);
    return messages.sort((a, b) => (times.get(a.id) ?? 0) - (times.get(b.id) ?? 0));
  }
  async media(selectedId: string, id: string) {
    const projection = new UiProjection(Infinity);
    if (selectedId.startsWith("legacy:")) {
      const legacy = this.gateway.store.get<LegacyTaskRecord>("legacy-tasks", selectedId.slice(7));
      if (!legacy) throw new UiError(404, "历史任务不存在。"); projection.history(legacy.history);
    } else {
      for (const message of this.gateway.messages(selectedId, controlActor)) for (const part of message.content ?? []) {
        if (part.type === "image" && imageAttachment(part.source).id === id) return readEmbeddedImage(part.source);
      }
      for (const item of this.gateway.store.list<{ sessionId: string; event: AgentApplicationEvent }>("events")) if (item.sessionId === selectedId) projection.event(item.event);
    }
    const source = projection.mediaSources.get(id); if (!source) throw new UiError(404, "图片不属于当前会话。");
    return readEmbeddedImage(source);
  }
  private legacyBlocks(task: LegacyTaskRecord): UiBlock[] {
    const projection = new UiProjection(Infinity); projection.history(task.history); projection.settle();
    return [{ id: `legacy:${task.id}`, kind: "notice", text: `历史任务 · ${task.status}\n${task.detail ?? ""}` }, ...projection.blocks.values()];
  }
  async resources(request: UiPageRequest) { return readPage(this.hostId, "resources", this.resourceList(), request, (item, query) => `${item.title} ${item.status}`.toLocaleLowerCase().includes(query)); }
  async history(selectedId: string, request: UiPageRequest) { return historyPage(this.hostId, selectedId, (await this.snapshot(selectedId, true)).blocks, request); }
  async field(selectedId: string, request: UiFieldRequest) {
    const block = (await this.snapshot(selectedId, true)).blocks.find(item => item.id === request.blockId);
    if (!block) throw new UiError(404, "记录不属于当前会话。");
    const text = request.field === "diagnostic" ? block.diagnostic?.message ?? "" : request.field === "presentation" ? block.presentation?.text ?? "" : block[request.field] ?? "";
    return fieldPage(this.hostId, selectedId, request, text);
  }

  async execute(command: UiCommand): Promise<UiReceipt> {
    if (command.hostId !== this.hostId) throw new UiError(409, "服务已经重启，请刷新状态。");
    const target = command.targetId && !command.targetId.startsWith("legacy:") ? this.gateway.session(command.targetId, controlActor) : undefined;
    const requestId = `ui:${command.requestId}`;
    if (command.name === "session.activate") {
      commandArgs(command, []);
      if (!command.targetId) throw new UiError(400, "需要选择会话。");
      await this.snapshot(command.targetId);
      return { selectedId: command.targetId };
    }
    if (command.name === "delivery.retry") {
      commandArgs(command, ["id", "scope"], ["confirm"]);
      if (!["current", "legacy"].includes(command.args.scope!)) throw new UiError(400, "投递范围无效。");
      if (command.args.scope === "legacy") {
        if (!this.retryLegacyDelivery) throw new UiError(409, "重新发送历史消息需要正在运行的 GatewayHost。");
        this.retryLegacyDelivery(command.args.id!, command.args.confirm === "true");
      } else this.gateway.retryDelivery(command.args.id!, controlActor, command.args.confirm === "true");
      return {};
    }
    if (command.name === "gateway.inspect") {
      commandArgs(command, ["kind"]);
      const data = command.args.kind === "agents" ? this.gateway.options.settings.agents
        : command.args.kind === "agent-status" ? this.gateway.status().agents
        : command.args.kind === "settings" ? this.gateway.options.settings
        : command.args.kind === "sessions" ? this.gateway.sessions(controlActor)
        : command.args.kind === "bindings" ? this.gateway.store.list<GatewayBinding>("bindings")
        : command.args.kind === "tasks" ? { tasks: this.gateway.store.list<GatewayTask>("tasks"), graphs: this.gateway.store.list("coordination") }
        : command.args.kind === "approvals" ? this.gateway.store.list<GatewayApproval>("approvals")
        : command.args.kind === "permission-rules" ? await this.gateway.listPermissionRules(controlActor)
        : command.args.kind === "channels" ? { host: this.hostStatus(), defaults: this.gateway.store.list("defaults"), entries: this.gateway.sessions(controlActor).filter(item => item.entry).map(item => ({ sessionId: item.id, name: item.name, entry: item.entry })) }
        : undefined;
      if (data === undefined) throw new UiError(400, "未知管理页面。");
      if (command.args.kind === "permission-rules") {
        const rules = await this.gateway.listPermissionRules(controlActor);
        return { output: { title: "持久权限规则", text: JSON.stringify(rules, null, 2), actions: rules.flatMap<UiAction>(rule => [
          { label: `${rule.id} · 保存相同范围的${rule.decision === "allow" ? "禁止" : "允许"}规则`, command: "permission.rule.create",
            args: { sourceId: rule.id, decision: rule.decision === "allow" ? "deny" : "allow" }, confirm: rule.description },
          { label: `${rule.id} · 撤销规则`, command: "permission.rule.revoke", args: { id: rule.id }, confirm: rule.description },
        ]) } };
      }
      return { output: { title: "服务管理", text: JSON.stringify(data, null, 2) } };
    }
    if (command.name === "session.new") {
      commandArgs(command, []);
      return { output: { title: "创建会话", text: "使用会话管理器填写名称与默认 Agent，或直接输入创建命令。", actions: [{ label: "直接使用命令创建", command: "gateway.command", args: {}, input: { name: "text", label: "创建命令", value: "/session create 新会话 --agent " } }] } };
    }
    if (command.name === "session.create") {
      commandArgs(command, ["name", "agents"], ["allowed", "entry"]);
      const entry = command.args.entry ? parseGatewayEntry(JSON.parse(command.args.entry)) : undefined;
      const text = quote(["/session", "create", command.args.name!, ...stringList(command.args.agents!).flatMap(id => ["--agent", id]), ...stringList(command.args.allowed ?? "[]").flatMap(id => ["--allow-agent", id])]);
      const result = await this.gateway.handle(text, controlActor, { requestId, ...(entry ? { entry } : {}) });
      return { selectedId: result.sessionId ?? null, output: { title: "会话", text: result.text } };
    }
    if (command.name === "gateway.command" || command.name === "message.submit") {
      commandArgs(command, ["text"], ["entry"]);
      if (command.name === "message.submit" && !target) throw new UiError(400, "需要先创建并选择会话。");
      const entry = command.args.entry ? parseGatewayEntry(JSON.parse(command.args.entry)) : undefined;
      const result = await this.gateway.handle(command.args.text!, controlActor, { requestId, ...(target ? { sessionId: target.id } : {}), ...(entry ? { entry } : {}) });
      return { ...(result.sessionId ? { selectedId: result.sessionId } : {}), output: { title: "Gateway", text: result.text } };
    }
    if (command.name === "approval.resolve") {
      commandArgs(command, ["id", "decision"]);
      if (!["allow", "allow-session", "allow-persistent", "deny"].includes(command.args.decision!)) throw new UiError(400, "审批决定无效。");
      await this.gateway.resolveApproval(command.args.id!, controlActor, command.args.decision as ApprovalDecision); return {};
    }
    if (command.name === "permission.rule.revoke") {
      commandArgs(command, ["id"]);
      const revoked = await this.gateway.revokePermissionRule(command.args.id!, controlActor);
      return { output: { title: "持久权限规则", text: revoked ? "已撤销规则。" : "规则不存在。" } };
    }
    if (command.name === "permission.rule.create") {
      commandArgs(command, ["sourceId", "decision"]);
      if (command.args.decision !== "allow" && command.args.decision !== "deny") throw new UiError(400, "持久权限决定必须为 allow 或 deny。");
      const rule = await this.gateway.createPermissionRule(command.args.sourceId!, command.args.decision, controlActor);
      return { output: { title: "持久权限规则", text: JSON.stringify(rule, null, 2) } };
    }
    if (command.name === "agent.save" || command.name === "agent.delete") {
      commandArgs(command, ["id"], command.name === "agent.save" ? ["config"] : ["confirm"]);
      if (command.name === "agent.delete" && command.args.confirm !== "true") throw new UiError(400, "删除 Agent 配置需要明确确认。");
      const config = command.name === "agent.save" ? JSON.parse(command.args.config ?? "null") as GatewayAgentConfig : null;
      if (command.name === "agent.save" && (!config || typeof config !== "object" || Array.isArray(config))) throw new UiError(400, "需要 Agent 配置对象。");
      await this.gateway.updateAgent(command.args.id!, controlActor, config); return {};
    }
    if (command.name === "agent.check") {
      commandArgs(command, ["id"], ["refresh"]);
      if (command.args.refresh !== undefined && !["true", "false"].includes(command.args.refresh)) throw new UiError(400, "refresh 必须为 true 或 false。");
      const adapter = await this.gateway.adapter(command.args.id!);
      const model = await adapter.modelCapabilities?.(command.args.refresh === "true");
      return { output: { title: "Agent 能力", text: JSON.stringify({ agent: adapter.capabilities, ...(model === undefined ? {} : { model }) }, null, 2),
        ...(adapter.modelCapabilities === undefined ? {} : { actions: [{ label: "刷新模型能力", command: "agent.check", args: { id: command.args.id!, refresh: "true" } }] }),
      } };
    }
    if (!target) throw new UiError(400, "需要先选择会话。");
    if (command.name === "session.diagnostics") {
      commandArgs(command, []);
      const bindings = this.gateway.store.list<GatewayBinding>("bindings").filter(binding => binding.sessionId === target.id && binding.conversationId !== undefined);
      const data = await Promise.all(bindings.map(async binding => {
        const adapter = await this.gateway.adapter(binding.agentId);
        const result = adapter.diagnostics?.(binding.conversationId!, { limit: 40 }) as UiTelemetryData | undefined;
        return { agentId: binding.agentId, panel: createTelemetryPanel(result) };
      }));
      return { output: { title: "当前会话执行诊断", text: data.length === 0 ? "当前会话尚无 Agent 对话。" : data.map(({ agentId, panel }) => `${agentId}\n${panel.fields.map(field => `${field.label}: ${field.value}`).join("\n")}`).join("\n\n") } };
    }
    if (command.name === "session.rename") {
      commandArgs(command, ["name"]); await this.gateway.updateSession(target.id, controlActor, { name: command.args.name! }); return {};
    }
    if (command.name === "session.bind") {
      commandArgs(command, ["entry", "confirm"]);
      await this.gateway.updateSession(target.id, controlActor, { entry: parseGatewayEntry(JSON.parse(command.args.entry!)), confirmBinding: command.args.confirm === "true" }); return {};
    }
    if (command.name === "session.admins") {
      commandArgs(command, ["admins"]); await this.gateway.setSessionAdmins(target.id, controlActor, stringList(command.args.admins!)); return {};
    }
    if (command.name === "run.cancel") { commandArgs(command, [], ["task"]); await this.gateway.stop(target, controlActor, undefined, command.args.task); return {}; }
    if (["session.archive", "session.restore", "session.delete"].includes(command.name)) {
      commandArgs(command, [], ["confirm"]);
      await this.gateway.manageSession(target, controlActor, command.name.slice(8), command.name === "session.delete" && command.args.confirm !== "false");
      return { selectedId: command.name === "session.delete" ? null : target.id };
    }
    if (command.name === "session.default") {
      commandArgs(command, []); if (!target.entry) throw new UiError(400, "会话没有绑定聊天入口。");
      const result = await this.gateway.handle(quote(["/session", "select", target.id]), controlActor, { requestId, entry: target.entry });
      return { output: { title: "聊天入口", text: result.text } };
    }
    if (command.name === "agent.default" || command.name === "agent.allow") {
      commandArgs(command, ["agents"]);
      const result = await this.gateway.handle(quote(["/agent", command.name.slice(6), ...stringList(command.args.agents!)]), controlActor, { requestId, sessionId: target.id });
      return { output: { title: "Agent", text: result.text } };
    }
    throw new UiError(400, "未知管理命令。");
  }
}

export function parseGatewayEntry(value: unknown): GatewayEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiError(400, "聊天入口必须为对象。");
  const entry = value as GatewayEntry;
  if (Object.keys(value).some(key => !["account", "conversation", "kind", "owner", "threadId"].includes(key))
    || !["private", "group"].includes(entry.kind) || typeof entry.account !== "string" || !entry.account.trim()
    || typeof entry.conversation !== "string" || !entry.conversation.trim() || entry.kind === "private" && (typeof entry.owner !== "string" || !entry.owner.trim())
    || entry.threadId !== undefined && (typeof entry.threadId !== "string" || !entry.threadId.trim())
    || entry.owner !== undefined && typeof entry.owner !== "string") throw new UiError(400, "聊天入口参数不正确。");
  return structuredClone(entry);
}
function stringList(value: string): string[] {
  const result: unknown = JSON.parse(value);
  if (!Array.isArray(result) || result.some(item => typeof item !== "string" || !item.trim())) throw new UiError(400, "需要字符串列表。");
  return result as string[];
}
