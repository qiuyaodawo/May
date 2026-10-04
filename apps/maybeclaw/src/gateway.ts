import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { channelTextPages } from "./channel-text.js";
import { inboxId, type ChannelInput } from "./channel-store.js";
import { gatewayInput } from "./gateway-input.js";
import { withGatewayConfiguration } from "./gateway-config.js";
import { CoordinationRuntime, coordinationInput, createCoordinationTools, validateCoordinationSnapshot, type CoordinationAgent, type CoordinationStore, type CoordinationSnapshot, type TaskExecution } from "@may/coordination";
import type { AgentApplicationEvent } from "@may/application";
import type { ApprovalDecision, ApprovalRequest, PersistentPermissionRule } from "@may/permissions";
import { FilePermissionRuleStore } from "@may/permissions/file-store";
import type { ContentPart, Tool } from "@may/core";
import { PluginHost } from "@may/plugin";
import { agentAdapterRegistryService } from "@may/plugin-agent-adapters";
import { coordinationService } from "@may/plugin-coordination";
import { createGatewayAgentPlugins } from "./plugins/agents.js";
import { GatewayStore } from "./gateway-store.js";
import { gatewayEntry } from "./gateway-settings.js";
import { digest } from "./types.js";
import type { LegacyTaskRecord } from "./gateway-migration.js";
import { actorKey, entryKey, type GatewayActor, type GatewayAgentAdapter, type GatewayApproval, type GatewayBinding, type GatewayDelivery,
  type GatewayEntry, type GatewayMessage, type GatewaySession, type GatewaySettings, type GatewayTask } from "./gateway-types.js";

export interface GatewayInput {
  requestId: string;
  sessionId?: string;
  entry?: GatewayEntry;
  messageId?: string;
  replyTo?: string;
  content?: ContentPart[];
  steeringInputId?: string;
}
export interface GatewayReceipt { text: string; sessionId?: string; taskIds?: string[] }
interface GraphRecord { id: string; sessionId: string; actor: GatewayActor; messageId: string; content?: ContentPart[]; rootInputId?: string }
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const unknownOutcome = (error: unknown): boolean => typeof error === "object" && error !== null && "outcome" in error && error.outcome === "unknown";
class CancellationUnsupportedError extends Error {}

export class AgentGateway {
  readonly store: GatewayStore;
  private readonly adapters = new Map<string, Promise<GatewayAgentAdapter>>();
  private readonly adapterStates = new Map<string, "loading" | "loaded" | "unavailable">();
  private readonly adapterClosings = new Map<string, Promise<void>>();
  private readonly adapterUsedAt = new Map<string, number>();
  private readonly graphs = new Map<string, CoordinationRuntime>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly dialogueJobs = new Map<string, Promise<void>>();
  private readonly inputAdmissions = new Map<string, Promise<void>>();
  private readonly activeBindings = new Map<string, string>();
  private readonly relays = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly approvalWaiters = new Map<string, (allowed: boolean) => void>();
  private readonly admission = new Map<string, { fingerprint: string; job: Promise<GatewayReceipt> }>();
  private readonly bindingJobs = new Map<string, Promise<GatewayBinding>>();
  private readonly taskJobs = new Map<string, Promise<void>>();
  private readonly reconfiguring = new Set<string>();
  private configurationWrite: Promise<void> = Promise.resolve();
  private readonly configurationJobs = new Set<Promise<void>>();
  private readonly maintenanceJobs = new Set<Promise<void>>();
  private runningCount = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private error: string | undefined;
  private plugins: Promise<PluginHost> | undefined;
  private permissionStore: Promise<FilePermissionRuleStore> | undefined;
  constructor(readonly options: { directory: string; configPath: string; settings: GatewaySettings; store?: GatewayStore }) {
    this.store = options.store ?? GatewayStore.open(options.directory);
    for (const delivery of this.store.list<GatewayDelivery>("deliveries")) if (delivery.status === "sending") this.store.put("deliveries", delivery.id, { ...delivery, status: "unknown" });
    for (const approval of this.store.list<GatewayApproval>("approvals")) {
      if (approval.status === "pending") this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
      else if (approval.status === "resolving") this.store.put("approvals", approval.id, { ...approval, status: "unknown" });
    }
  }
  observe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private pluginHost(): Promise<PluginHost> { return this.plugins ??= PluginHost.create({ plugins: createGatewayAgentPlugins({ ...this.options, permissionRuleStore: () => this.ruleStore() }) }); }
  private ruleStore(): Promise<FilePermissionRuleStore> {
    if (this.closing) return Promise.reject(new Error("Gateway 正在关闭。"));
    if (!this.options.settings.persistentRules) return Promise.reject(new Error("持久权限规则尚未启用。"));
    return this.permissionStore ??= FilePermissionRuleStore.open({ path: join(this.options.directory, "permission-rules.json") });
  }
  async listPermissionRules(actor: GatewayActor): Promise<readonly PersistentPermissionRule[]> {
    if (actor.kind !== "operator") throw new Error("查看持久权限规则需要服务管理员权限。");
    return (await this.ruleStore()).list();
  }
  async revokePermissionRule(id: string, actor: GatewayActor): Promise<boolean> {
    if (actor.kind !== "operator") throw new Error("撤销持久权限规则需要服务管理员权限。");
    const store = await this.ruleStore();
    const rule = (await store.list()).find(entry => entry.id === id);
    const revoked = await store.revoke(id);
    if (revoked) {
      const eventId = randomUUID();
      this.store.put("permission-rule-events", eventId, { type: "rule.revoked", ruleId: id, scopeId: rule?.scopeId, actor, at: Date.now() });
    }
    this.changed();
    return revoked;
  }
  async createPermissionRule(sourceId: string, decision: "allow" | "deny", actor: GatewayActor): Promise<PersistentPermissionRule> {
    if (actor.kind !== "operator") throw new Error("创建持久权限规则需要服务管理员权限。");
    if (decision !== "allow" && decision !== "deny") throw new TypeError("持久权限决定必须为 allow 或 deny。");
    const store = await this.ruleStore();
    const source = (await store.list()).find(rule => rule.id === sourceId);
    if (!source) throw new Error("来源规则不存在。");
    const scope: unknown = JSON.parse(source.scopeId);
    if (!Array.isArray(scope) || scope.length !== 5 || scope[0] !== "maybeclaw-v1" || scope[1] !== resolve(this.options.directory) || typeof scope[2] !== "string" || typeof scope[4] !== "string") throw new Error("来源规则不属于当前 Gateway。");
    const agent = this.options.settings.agents.find(item => item.id === scope[2]);
    if (!agent || agent.adapter !== "may" || agent.enabled === false || agent.permissions?.[source.toolName] === "deny") throw new Error("来源规则的 Agent 或工具权限已经失效。");
    if (scope[3] !== (agent.readDirectory ? await realpath(agent.readDirectory) : null)) throw new Error("来源规则的项目目录已经变化。");
    const identity: unknown = JSON.parse(scope[4]);
    if (!Array.isArray(identity) || identity.some(value => typeof value !== "string" || !value.trim()) ||
      !(identity.length === 2 && identity[0] === "operator" || identity.length === 3 && identity[0] === "platform")) throw new Error("来源规则的身份范围无效。");
    if (identity[0] === "platform" && this.options.settings.access.deniedUsers.includes(`${identity[1]}:${identity[2]}`)) throw new Error("来源规则的身份权限已经撤销。");
    const createdAt = Date.now();
    if (source.expiresAt !== undefined && source.expiresAt <= createdAt) throw new Error("来源规则已经过期。");
    const rule: PersistentPermissionRule = { ...source, id: randomUUID(), decision, createdAt, createdBy: actorKey(actor) };
    await store.create(rule);
    this.store.put("permission-rule-events", rule.id, { type: "rule.created", rule, actor, at: createdAt });
    this.changed();
    return rule;
  }
  changed(): void { for (const listener of this.listeners) listener(); }
  status() { return { state: this.closing ? "stopping" : this.error ? "degraded" : "running", error: this.error,
    agents: this.options.settings.agents.map(agent => ({ id: agent.id, name: agent.name ?? agent.id, enabled: agent.enabled !== false,
      status: this.reconfiguring.has(agent.id) ? "reconfiguring" : agent.enabled === false ? "disabled" : this.adapterClosings.has(agent.id) ? "releasing" : this.adapterStates.get(agent.id) ?? "unloaded" })),
    active: this.store.list<GatewayTask>("tasks").filter(task => !terminal(task.status)).length }; }
  async adapter(id: string): Promise<GatewayAgentAdapter> {
    if (this.closing) throw new Error("Gateway is closing");
    await this.adapterClosings.get(id);
    if (this.closing) throw new Error("Gateway is closing");
    return this.resolveAdapter(id);
  }
  private async resolveAdapter(id: string): Promise<GatewayAgentAdapter> {
    await this.adapterClosings.get(id);
    const config = this.options.settings.agents.find(agent => agent.id === id);
    if (!config) throw new Error(`Agent ${id} 未登记。请使用 /agent list 查看可用 Agent。`);
    this.adapterUsedAt.set(id, Date.now());
    let pending = this.adapters.get(id);
    if (!pending) {
      this.adapterStates.set(id, "loading");
      pending = this.pluginHost().then(host => host.get(agentAdapterRegistryService).get(id)).then(adapter => {
        this.adapterStates.set(id, "loaded"); this.changed(); return adapter;
      }, error => {
        this.adapterStates.set(id, "unavailable");
        if (this.adapters.get(id) === pending) this.adapters.delete(id);
        this.changed(); throw error;
      });
      this.adapters.set(id, pending);
      this.changed();
    }
    return pending;
  }
  canAccess(session: GatewaySession, actor: GatewayActor): boolean {
    if (actor.kind === "operator") return true;
    if (this.options.settings.access.deniedUsers.includes(actorKey(actor))) return false;
    const entry = session.entry;
    return !!entry && entry.account === actor.account && entry.conversation === actor.conversation
      && (entry.threadId ?? null) === (actor.threadId ?? null) && (entry.kind === "group"
        ? this.store.get<{ active: boolean }>("memberships", digest({ account: actor.account, conversation: actor.conversation, userId: actor.userId }))?.active !== false
        : entry.owner === actor.userId);
  }
  async setMemberAccess(entry: GatewayEntry, userId: string, active: boolean, occurredAt = Date.now()): Promise<void> {
    gatewayEntry(entry);
    if (entry.kind !== "group" || !userId) throw new Error("成员变更需要群聊入口和用户 ID。");
    if (!Number.isFinite(occurredAt) || occurredAt < 0) throw new Error("成员变更事件时间无效。");
    const id = digest({ account: entry.account, conversation: entry.conversation, userId });
    const prior = this.store.get<{ updatedAt: number }>("memberships", id);
    if (prior && prior.updatedAt > occurredAt) return;
    this.store.put("memberships", id, { id, account: entry.account, conversation: entry.conversation, userId, active, updatedAt: occurredAt });
    if (!active) {
      const sessions = this.store.list<GatewaySession>("sessions").filter(session => session.entry?.kind === "group" && session.entry.account === entry.account && session.entry.conversation === entry.conversation);
      for (const session of sessions) {
        for (const approval of this.store.list<GatewayApproval>("approvals")) if (approval.sessionId === session.id && approval.actor.kind === "platform" && approval.actor.userId === userId && approval.status === "pending") {
          try {
            if (approval.kind === "tool") {
              const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${approval.agentId}`);
              if (binding?.conversationId) await (await this.resolveAdapter(approval.agentId)).resolveApproval?.(binding.conversationId, approval.requestId, "deny");
            }
            this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
          } catch (error) {
            if (!unknownOutcome(error)) throw error;
            this.store.put("approvals", approval.id, { ...approval, status: "unknown", decision: "deny", decidedBy: { kind: "operator", id: "membership" } });
            this.record(session, { kind: "notice", text: `成员 ${userId} 的访问权限已撤销；审批 ${approval.id} 的拒绝结果尚未确认，需要核对 Agent 状态。`, agentId: approval.agentId, ...(approval.taskId ? { taskId: approval.taskId } : {}) });
          }
          this.approvalWaiters.get(approval.id)?.(false); this.approvalWaiters.delete(approval.id);
        }
        for (const task of this.store.list<GatewayTask>("tasks")) if (task.sessionId === session.id && task.actor.kind === "platform" && task.actor.userId === userId && !terminal(task.status)) {
          let notice: string | undefined;
          try { await this.stop(session, { kind: "operator", id: "membership" }, undefined, task.id); }
          catch (error) {
            if (error instanceof CancellationUnsupportedError) notice = `成员 ${userId} 的访问权限已撤销；Agent ${task.agentId} 不支持取消，任务 ${task.id} 仍在执行。`;
            else if (unknownOutcome(error)) {
              notice = `成员 ${userId} 的访问权限已撤销；任务 ${task.id} 的取消结果尚未确认，需要核对 Agent 状态。`;
              const current = this.store.get<GatewayTask>("tasks", task.id);
              if (current && !terminal(current.status)) this.store.put("tasks", task.id, { ...current, status: "recovery-required", detail: notice, updatedAt: Date.now() });
            } else throw error;
          }
          const current = this.store.get<GatewayTask>("tasks", task.id);
          if (!notice && current?.status === "recovery-required") notice = `成员 ${userId} 的访问权限已撤销；任务 ${task.id} 的执行结果尚未确认，需要核对 Agent 状态。`;
          if (notice && !this.store.list<GatewayMessage>("messages").some(message => message.sessionId === session.id && message.taskId === task.id && message.text === notice)) this.record(session, { kind: "notice", text: notice, agentId: task.agentId, taskId: task.id });
        }
      }
    }
    this.changed();
  }
  isAdmin(session: GatewaySession, actor: GatewayActor): boolean {
    return actor.kind === "operator" || this.canAccess(session, actor) && (
      this.options.settings.access.sessionAdmins[session.id]?.includes(actorKey(actor)) === true
      || session.entry?.kind === "private" && session.entry.owner === actor.userId);
  }
  sessions(actor: GatewayActor): GatewaySession[] { return this.store.list<GatewaySession>("sessions").filter(session => this.canAccess(session, actor)); }
  session(id: string, actor: GatewayActor): GatewaySession {
    const matches = this.sessions(actor).filter(session => session.id === id || session.name === id);
    if (matches.length !== 1) throw new Error("会话不存在、名称不唯一或当前身份无权访问。请使用 /session list 查询。");
    return matches[0]!;
  }
  messages(id: string, actor: GatewayActor): GatewayMessage[] {
    this.session(id, actor);
    return this.store.list<GatewayMessage>("messages").filter(message => message.sessionId === id).sort((a, b) => a.seq - b.seq);
  }
  resolveTargets(text: string, actor: GatewayActor, input: GatewayInput): { session: GatewaySession; agents: string[] } {
    const parsed = gatewayInput(text), words = [...parsed.words];
    let selected = input.sessionId;
    if (words[0] === "/session") { words.shift(); selected = this.session(words.shift() ?? "", actor).id; }
    const reply = input.entry && input.replyTo ? this.store.get<{ sessionId: string; agentId?: string }>("platform-messages", `${entryKey(input.entry)}:${input.replyTo}`) : undefined;
    selected ??= reply?.sessionId ?? (input.entry ? this.store.get<{ sessionId: string }>("defaults", entryKey(input.entry))?.sessionId : undefined);
    if (!selected) throw new Error("请先创建并选择会话。");
    const session = this.session(selected, actor);
    const explicit = words[0]?.startsWith("@") ? words[0].slice(1) : reply?.sessionId === session.id ? reply.agentId : undefined;
    const agents = explicit ? [explicit] : session.defaultAgents;
    for (const id of agents) this.authorizeAgent(id, actor, session.entry);
    return { session, agents };
  }
  createSession(actor: GatewayActor, name: string, agents: string[], allowed: string[] = [], entry?: GatewayEntry): GatewaySession {
    if (entry) entry = gatewayEntry(entry);
    if (!name.trim() || name.length > 128 || !agents.length) throw new Error("创建会话需要名称和至少一个默认 Agent。");
    if (actor.kind !== "operator" && (entry?.kind !== "private" || entry.owner !== actor.userId)
      && !this.options.settings.access.creators.includes(actorKey(actor))) throw new Error("当前身份没有创建群会话的权限。");
    if (actor.kind !== "operator" && (!entry || entry.account !== actor.account || entry.conversation !== actor.conversation || (entry.threadId ?? null) !== (actor.threadId ?? null))) throw new Error("只能在当前聊天入口创建会话。");
    for (const agent of [...agents, ...allowed]) this.authorizeAgent(agent, actor, entry);
    if (this.store.list<GatewaySession>("sessions").some(session => session.name === name && (session.entry ? entry && entryKey(session.entry) === entryKey(entry) : !entry))) throw new Error("当前入口已有同名会话。");
    const now = Date.now(), session: GatewaySession = { id: randomUUID(), name, defaultAgents: [...new Set(agents)], allowedAgents: [...new Set([...agents, ...allowed])],
      status: "active", createdAt: now, updatedAt: now, ...(entry ? { entry } : {}) };
    this.store.put("sessions", session.id, session); this.changed(); return session;
  }
  private authorizeAgent(id: string, actor: GatewayActor, entry?: GatewayEntry, acceptedWork = false): void {
    const agent = this.options.settings.agents.find(item => item.id === id);
    if (!agent || agent.enabled === false || this.reconfiguring.has(id) && !acceptedWork) throw new Error(`Agent ${id} 不可用。请使用 /agent list 查看配置，并使用 /agent create <Agent> 尝试创建其他 Agent 对话。`);
    const scope = entry ? entryKey(entry) : actorKey(actor);
    const allowed = this.options.settings.access.allowedAgents[scope] ?? this.options.settings.access.allowedAgents[actorKey(actor)];
    if (allowed && !allowed.includes(id)) throw new Error(`当前会话无权使用 Agent ${id}。`);
  }
  private requireAdmin(session: GatewaySession, actor: GatewayActor): void { if (!this.isAdmin(session, actor)) throw new Error("此操作需要会话管理员权限。"); }
  updateSession(id: string, actor: GatewayActor, update: { name?: string; defaultAgents?: string[]; allowedAgents?: string[]; entry?: GatewayEntry; confirmBinding?: boolean }): GatewaySession {
    const session = this.session(id, actor); this.requireAdmin(session, actor);
    if (update.entry) {
      const checkedEntry = gatewayEntry(update.entry);
      update = { ...update, entry: checkedEntry };
      if (actor.kind !== "operator") throw new Error("绑定聊天入口需要服务管理员权限。");
      if (session.entry && (entryKey(session.entry) !== entryKey(checkedEntry) || session.entry.kind !== checkedEntry.kind || session.entry.owner !== checkedEntry.owner)) throw new Error("已有会话不能更改身份或群聊范围。");
      if (!update.confirmBinding) throw new Error("绑定入口将向目标参与者开放会话历史，请确认 confirmBinding。");
      if (checkedEntry.kind === "private" && !checkedEntry.owner) throw new Error("个人会话需要绑定身份。");
    }
    const name = update.name ?? session.name, entry = update.entry ?? session.entry;
    if (!name.trim() || name.length > 128) throw new Error("会话名称无效。");
    if (this.store.list<GatewaySession>("sessions").some(other => other.id !== id && other.name === name && (other.entry ? entry && entryKey(other.entry) === entryKey(entry) : !entry))) throw new Error("目标入口已有同名会话。");
    const defaults = update.defaultAgents ?? session.defaultAgents;
    if (!defaults.length) throw new Error("需要至少一个默认 Agent。");
    const allowed = [...new Set([...(update.allowedAgents ?? session.allowedAgents), ...defaults])];
    for (const agent of [...defaults, ...allowed]) this.authorizeAgent(agent, actor, entry);
    const result: GatewaySession = { ...session, name, defaultAgents: [...new Set(defaults)], allowedAgents: allowed, ...(entry ? { entry } : {}), updatedAt: Date.now() };
    this.store.put("sessions", id, result); this.changed(); return result;
  }
  async setSessionAdmins(id: string, actor: GatewayActor, keys: string[]): Promise<void> {
    if (actor.kind !== "operator") throw new Error("配置会话管理员需要服务管理员权限。");
    this.session(id, actor);
    if (keys.some(key => !key.trim())) throw new Error("管理员身份不能为空。");
    await this.saveConfiguration(raw => {
      const access = raw.access as Record<string, unknown> | undefined;
      raw.access = { ...access, sessionAdmins: { ...(access?.sessionAdmins as object ?? {}), [id]: [...new Set(keys)] } };
    });
    this.options.settings.access.sessionAdmins[id] = [...new Set(keys)]; this.changed();
  }
  async updateAgent(id: string, actor: GatewayActor, config: import("./gateway-types.js").GatewayAgentConfig | null): Promise<void> {
    if (this.closing) throw new Error("Gateway 正在关闭。");
    if (actor.kind !== "operator") throw new Error("修改 Agent 配置需要服务管理员权限。");
    if (config && config.id !== id) throw new Error("Agent ID 与配置不一致。");
    if (this.reconfiguring.has(id)) throw new Error(`Agent ${id} 已在等待配置更新。`);
    if (!config && this.store.list<GatewayBinding>("bindings").some(binding => binding.agentId === id)) throw new Error("Agent 仍有关联对话，请先清理对应会话。");
    this.reconfiguring.add(id); this.changed();
    let finishConfiguration!: () => void;
    const configurationJob = new Promise<void>(resolve => { finishConfiguration = resolve; });
    this.configurationJobs.add(configurationJob);
    try {
      const unresolved = () => this.store.list<GatewayTask>("tasks").some(task => task.agentId === id && task.status === "recovery-required");
      if (unresolved()) throw new Error(`Agent ${id} 存在需要核对的执行结果，请处理恢复事项后修改配置。`);
      if (this.store.list<{ agentId: string; status: string }>("steering").some(item => item.agentId === id && ["pending", "idle", "sending", "starting", "unknown"].includes(item.status))) throw new Error(`Agent ${id} 仍有已接收的补充信息，请处理后修改配置。`);
      await Promise.all([...this.inputAdmissions.values()]);
      await this.waitForAgentApprovals(id);
      await Promise.all([...this.bindingJobs].filter(([key]) => this.store.get<GatewayBinding>("bindings", key)?.agentId === id).map(([, job]) => job));
      const graphs = this.store.list<CoordinationSnapshot>("coordination").filter(graph => graph.tasks.some(task => !terminal(task.status)));
      if (graphs.some(graph => graph.tasks.some(task => task.status === "recovery-required"))) throw new Error(`Agent ${id} 的协作任务需要核对，请处理恢复事项后修改配置。`);
      await Promise.all(graphs.map(graph => this.jobs.get(graph.id)));
      await Promise.all(this.store.list<GatewayTask>("tasks").filter(task => task.agentId === id && !terminal(task.status)).map(task => this.taskJobs.get(task.id)));
      const unfinished = this.store.list<CoordinationSnapshot>("coordination").some(graph => (graphs.some(prior => prior.id === graph.id) || graph.tasks.some(task => task.agent === id && !terminal(task.status))) && graph.tasks.some(task => !terminal(task.status)));
      if (unfinished || this.store.list<GatewayTask>("tasks").some(task => task.agentId === id && !terminal(task.status))) throw new Error(`Agent ${id} 仍有等待或需要核对的任务，请完成或停止协作任务后修改配置。`);
      if (this.closing) throw new Error("Gateway 正在关闭，尚未应用 Agent 配置。");
      await this.saveConfiguration(raw => {
        if (raw.agents !== undefined && !Array.isArray(raw.agents)) throw new Error("agents 必须为列表。");
        const currentAgents = (raw.agents ?? []) as import("./gateway-types.js").GatewayAgentConfig[];
        raw.agents = currentAgents.filter(agent => agent.id !== id).concat(config ? [config] : []);
      });
      const previous = this.adapters.get(id);
      if (previous) await this.closeAdapter(id, previous);
      this.adapterStates.delete(id);
      const index = this.options.settings.agents.findIndex(agent => agent.id === id);
      if (index >= 0) this.options.settings.agents.splice(index, 1);
      if (config) this.options.settings.agents.push(config);
    } finally { finishConfiguration(); this.configurationJobs.delete(configurationJob); this.reconfiguring.delete(id); this.changed(); }
  }
  private waitForAgentApprovals(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const inspect = () => {
        if (this.closing) { unsubscribe(); reject(new Error("Gateway 正在关闭，尚未应用 Agent 配置。")); return; }
        const approvals = this.store.list<GatewayApproval>("approvals").filter(approval => approval.agentId === id);
        if (approvals.some(approval => approval.status === "unknown")) { unsubscribe(); reject(new Error(`Agent ${id} 存在需要核对的审批结果。`)); }
        else if (!approvals.some(approval => approval.status === "pending" || approval.status === "resolving")) { unsubscribe(); resolve(); }
      };
      const unsubscribe = this.observe(inspect);
      inspect();
    });
  }
  private saveConfiguration(change: (raw: Record<string, unknown>) => void): Promise<void> {
    const job = withGatewayConfiguration(this.options.configPath, async (raw, save) => {
      change(raw);
      const { gatewaySettings } = await import("./gateway-settings.js");
      gatewaySettings({ path: this.options.configPath, providers: {}, models: {}, apps: { maybeclaw: raw } });
      await save();
    });
    this.configurationWrite = job.then(() => {}, () => {}); return job;
  }
  private record(session: GatewaySession, data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">, deliver = true): GatewayMessage {
    return this.store.transaction(() => {
      const current = this.store.get<GatewaySession>("sessions", session.id);
      if (!current) throw new Error("会话已被删除。");
      session = current;
      const seq = (this.store.get<{ seq: number }>("sequences", session.id)?.seq ?? 0) + 1;
      const message: GatewayMessage = { ...data, id: randomUUID(), sessionId: session.id, seq, createdAt: Date.now() };
      this.store.put("sequences", session.id, { seq }); this.store.put("messages", message.id, message);
      if (session.entry && deliver) {
        const title = `${session.name} · ${data.agentId ?? (data.actor?.kind === "operator" ? "服务管理员" : "MaybeClaw")}`;
        const unsupported = [...new Set((data.content ?? []).filter(part => ["audio", "file", "resource"].includes(part.type)).map(part => part.type))];
        const body = unsupported.length ? `${data.text}\n\n当前渠道无法发送以下附件类型：${unsupported.join("、")}。完整内容已保存在会话历史中。` : data.text;
        const pages = channelTextPages(body, 3000);
        const task = data.taskId ? this.store.get<GatewayTask>("tasks", data.taskId) : undefined;
        const graph = task ? this.store.get<GraphRecord>("graphs", task.graphId) : undefined;
        const original = graph ? this.store.get<GatewayMessage>("messages", graph.messageId) : undefined;
        let after: string | undefined;
        for (const [index, page] of pages.entries()) {
          const id = digest({ message: message.id, part: index });
          const delivery: GatewayDelivery = { id, sessionId: session.id, messageId: message.id, entry: session.entry,
            text: `${title}\n${page}`, status: "pending", ...(after ? { after } : {}), ...(original?.sourceMessageId ? { replyTo: original.sourceMessageId } : {}) };
          this.store.put("deliveries", id, delivery); after = id;
        }
        for (const [index, part] of (data.content ?? []).entries()) if (part.type === "image") {
          const id = digest({ message: message.id, image: index });
          this.store.put("deliveries", id, { id, sessionId: session.id, messageId: message.id, entry: session.entry, text: title, image: part, status: "pending", ...(after ? { after } : {}), ...(original?.sourceMessageId ? { replyTo: original.sourceMessageId } : {}) } satisfies GatewayDelivery); after = id;
        }
      }
      this.store.put("sessions", session.id, { ...session, updatedAt: message.createdAt }); this.changed(); return message;
    });
  }
  recordChannelChange(input: ChannelInput, originalState: string, sessionId?: string): void {
    if (input.eventType !== "edit" && input.eventType !== "delete" || !input.messageId) throw new Error("平台消息变更需要有效的类型和原消息 ID。");
    this.store.transaction(() => {
      const id = `${inboxId(input)}:change`;
      const existing = this.store.get<{ id: string; input: ChannelInput; originalState: string; sessionId?: string; noticeId?: string }>("message-changes", id);
      if (existing && digest(existing.input) !== digest(input)) throw new Error("平台消息变更事件 ID 内容冲突。");
      if (existing?.sessionId && sessionId && existing.sessionId !== sessionId) throw new Error("平台消息变更的会话关联发生冲突。");
      if (existing?.noticeId) return;
      const change = { ...existing, id, input, originalState: existing?.originalState ?? originalState, ...(sessionId ? { sessionId } : {}) };
      const session = change.sessionId ? this.store.get<GatewaySession>("sessions", change.sessionId) : undefined;
      if (session && !["pending", "deleted"].includes(change.originalState)) {
        const actor: GatewayActor = { kind: "platform", account: input.account, conversation: input.conversation, userId: input.sender, ...(input.threadId ? { threadId: input.threadId } : {}) };
        const text = input.eventType === "delete" ? `${actorKey(actor)} 已撤回平台消息 ${input.messageId}。原执行输入继续保存在历史中。`
          : `${actorKey(actor)} 已编辑平台消息 ${input.messageId}。\n最新正文：\n${input.text}`;
        const notice = this.record(session, { kind: "notice", text, actor, sourceMessageId: input.messageId!, sourceEntry: entryKey(input) }, false);
        this.store.put("message-changes", id, { ...change, noticeId: notice.id });
      } else this.store.put("message-changes", id, change);
    });
    this.changed();
  }
  handle(text: string, actor: GatewayActor, input: GatewayInput): Promise<GatewayReceipt> {
    if (this.closing) return Promise.reject(new Error("Gateway 正在关闭。"));
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65_536 || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 256) return Promise.reject(new Error("消息不得超过 64 KiB，且必须提供有效请求 ID。"));
    if (input.entry) gatewayEntry(input.entry);
    const key = digest({ actor: actorKey(actor), requestId: input.requestId });
    const fingerprint = digest({ text, actor, input });
    const pending = this.admission.get(key);
    if (pending) return pending.fingerprint === fingerprint ? pending.job : Promise.reject(new Error("请求 ID 已用于其他输入。"));
    const saved = this.store.get<{ fingerprint: string; result?: GatewayReceipt; error?: string }>("receipts", key);
    if (saved) {
      if (saved.fingerprint !== fingerprint) return Promise.reject(new Error("请求 ID 已用于其他输入。"));
      return saved.result ? Promise.resolve(saved.result) : Promise.reject(new Error(saved.error ?? "原请求尚无确认结果，请查询会话与任务状态。"));
    }
    this.store.put("receipts", key, { id: key, fingerprint });
    const job = this.process(text, actor, input).then(result => { this.store.put("receipts", key, { id: key, fingerprint, result, sessionId: result.sessionId ?? null }); return result; }, error => {
      this.store.put("receipts", key, { id: key, fingerprint, error: safeError(error), sessionId: input.sessionId ?? null }); throw error;
    });
    this.admission.set(key, { fingerprint, job });
    void job.finally(() => this.admission.delete(key)).catch(() => undefined);
    return job;
  }
  private async process(text: string, actor: GatewayActor, input: GatewayInput): Promise<GatewayReceipt> {
    if (actor.kind === "platform" && this.options.settings.access.deniedUsers.includes(actorKey(actor))) throw new Error("当前身份已被撤销访问权限。");
    const parsed = gatewayInput(text);
    const words = [...parsed.words];
    if (!words.length) throw new Error("请输入消息。");
    let selected = input.sessionId;
    if (words[0] === "/session") {
      words.shift(); const target = words.shift();
      if (!parsed.literalSession && target === "list") return { text: this.sessions(actor).map(session => `${session.id}  ${session.name}  ${session.status}`).join("\n") || "尚无会话。使用 /session create <名称> --agent <Agent> 创建。" };
      if (!parsed.literalSession && target === "create") {
        const name = words.shift(), agents: string[] = [], allowed: string[] = [];
        while (words.length) { const flag = words.shift(), value = words.shift(); if (!value || !["--agent", "--allow-agent"].includes(flag!)) throw new Error("用法：/session create <名称> --agent <Agent> [--allow-agent <Agent>]"); (flag === "--agent" ? agents : allowed).push(value); }
        const session = this.createSession(actor, name ?? "", agents, allowed, input.entry);
        return { text: `已创建 ${session.name}\n${session.id}\n使用 /session select ${session.id} 选择会话。`, sessionId: session.id };
      }
      if (!parsed.literalSession && target === "select") {
        const session = this.session(words.shift() ?? "", actor); this.requireAdmin(session, actor);
        const active = this.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session.id && !terminal(task.status)).length;
        const deliveries = this.store.list<GatewayDelivery>("deliveries").filter(item => item.sessionId === session.id);
        const pending = new Set(deliveries.filter(item => ["pending", "sending", "failed"].includes(item.status)).map(item => item.messageId)).size;
        const unknown = new Set(deliveries.filter(item => item.status === "unknown").map(item => item.messageId)).size;
        const progress = `\n进行中的任务：${active}\n未发送消息：${pending}${unknown ? `\n投递结果未确认：${unknown}` : ""}`;
        if (!input.entry) return { text: `已选择 ${session.name}${progress}`, sessionId: session.id };
        this.store.put("defaults", entryKey(input.entry), { sessionId: session.id }); this.changed();
        return { text: `${actorKey(actor)} 已将入口默认会话设置为 ${session.name}。默认 Agent：${session.defaultAgents.join(", ")}${progress}`, sessionId: session.id };
      }
      if (!parsed.literalSession && ["archive", "restore", "delete"].includes(target ?? "")) {
        const session = this.session(words.shift() ?? selected ?? "", actor);
        await this.manageSession(session, actor, target!, words.includes("--confirm"));
        return { text: `会话操作已完成：${target}`, sessionId: session.id };
      }
      selected = this.session(target ?? "", actor).id;
    }
    if (words[0] === "/agent" && words[1] === "list") return { text: this.status().agents.map(agent => `${agent.id}  ${agent.status}`).join("\n") };
    if (["/status", "/result", "/cancel"].includes(words[0] ?? "") && words[1]) {
      const legacy = this.store.get<LegacyTaskRecord>("legacy-tasks", words[1]);
      if (legacy) {
        if (actor.kind !== "operator" && (actor.threadId || !legacy.origins.some(origin => origin.account === actor.account && origin.conversation === actor.conversation && origin.sender === actor.userId))) throw new Error("当前身份无权查看此历史任务。");
        if (words[0] === "/cancel") {
          if (legacy.status !== "awaiting-assignment") throw new Error("该历史任务当前无法取消，请查询原执行状态。");
          this.store.put("legacy-tasks", legacy.id, { ...legacy, status: "cancelled", cancellationRequested: true });
          return { text: `历史任务已取消：${legacy.id}` };
        }
        return { text: `${legacy.id} · 历史任务 · ${legacy.status}\n${words[0] === "/result" ? legacy.result ?? legacy.detail ?? "结果尚未生成。" : legacy.detail ?? ""}` };
      }
      selected ??= this.store.get<GatewayTask>("tasks", words[1])?.sessionId;
    }
    const reply = input.entry && input.replyTo ? this.store.get<{ sessionId: string; agentId?: string }>("platform-messages", `${entryKey(input.entry)}:${input.replyTo}`) : undefined;
    selected ??= reply?.sessionId ?? (input.entry ? this.store.get<{ sessionId: string }>("defaults", entryKey(input.entry))?.sessionId : undefined);
    if (!selected) throw new Error("请先创建并选择会话：/session create <名称> --agent <Agent>，然后 /session select <会话>。");
    const session = this.session(selected, actor);
    let agentId = words[0]?.startsWith("@") ? words.shift()!.slice(1) : reply?.sessionId === session.id ? reply.agentId : undefined;
    const command = words[0];
    if (command === "/history") {
      const marker = words.indexOf("--before"), before = marker < 0 ? Infinity : Number(words[marker + 1]);
      if (!(before > 0)) throw new Error("历史游标无效。");
      const messages = this.messages(session.id, actor).filter(message => message.seq < before).slice(-20);
      return { text: messages.map(message => `${message.seq} · ${message.agentId ?? message.kind}\n${message.text}`).join("\n\n") + (messages.length ? `\n/history --before ${messages[0]!.seq}` : "暂无历史。"), sessionId: session.id };
    }
    if (command === "/approve" || command === "/deny") {
      await this.resolveApproval(words[1] ?? "", actor, command === "/deny" ? "deny" : words.includes("--persistent") ? "allow-persistent" : words.includes("--session") ? "allow-session" : "allow");
      return { text: "审批已处理。", sessionId: session.id };
    }
    if (command === "/status" || command === "/result") {
      const tasks = this.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session.id && (!words[1] || task.id === words[1]));
      return { text: tasks.map(task => `${task.id} · ${task.agentId} · ${task.status}\n${command === "/result" ? task.result ?? task.detail ?? "结果尚未生成。" : task.detail ?? ""}`).join("\n") || "没有对应任务。", sessionId: session.id };
    }
    if (command === "/agent") {
      const operation = words[1];
      if (operation === "default" || operation === "allow") {
        if (words.length === 2) return { text: (operation === "default" ? session.defaultAgents : session.allowedAgents).join(", "), sessionId: session.id };
        this.requireAdmin(session, actor);
        const values = [...new Set(words.slice(2))]; for (const id of values) this.authorizeAgent(id, actor, session.entry);
        const updated = { ...session, ...(operation === "default" ? { defaultAgents: values, allowedAgents: [...new Set([...session.allowedAgents, ...values])] } : { allowedAgents: [...new Set([...values, ...session.defaultAgents])] }), updatedAt: Date.now() };
        this.store.put("sessions", session.id, updated); this.changed();
        return { text: `已修改 ${session.name} 的 ${operation}：${values.join(", ")}`, sessionId: session.id };
      }
      if (operation === "create") {
        if (session.status !== "active") throw new Error("请先恢复会话。");
        const id = words[2] ?? ""; this.authorizeAgent(id, actor, session.entry);
        if (!session.allowedAgents.includes(id) && !this.isAdmin(session, actor)) {
          const approval = this.requestApproval(session, id, actor, "create-agent", input.requestId, `创建 ${id} 对话`);
          return { text: `等待创建审批：${approval.id}`, sessionId: session.id };
        }
        const binding = await this.binding(session, id); return { text: `${id} 对话已就绪：${binding.conversationId}`, sessionId: session.id };
      }
      if (operation === "command") {
        if (session.status !== "active") throw new Error("请先恢复会话。");
        const id = words[2] ?? "", name = words[3] ?? "";
        if (["new", "resume", "/new", "/resume"].includes(name)) throw new Error("请通过 MaybeClaw 会话命令管理 Agent 对话。");
        this.requireAdmin(session, actor); this.authorizeAgent(id, actor, session.entry);
        const adapter = await this.resolveAdapter(id), binding = await this.binding(session, id);
        if (!adapter.command) throw new Error("该 Agent 没有声明命令能力。");
        return { text: await adapter.command(binding.conversationId!, name, words.slice(4)), sessionId: session.id };
      }
      throw new Error("用法：/agent list|default|allow|create|command");
    }
    if (command === "/stop" || command === "/cancel") {
      const taskId = command === "/cancel" ? words[1] : words.includes("--task") ? words[words.indexOf("--task") + 1] : undefined;
      if (command === "/cancel" && !taskId || words.includes("--task") && !taskId) throw new Error("请填写任务 ID：/stop --task <ID>。");
      if (words.includes("--session")) { const target = this.session(words[words.indexOf("--session") + 1] ?? "", actor); this.requireAdmin(target, actor); await this.stop(target, actor); }
      else {
        const candidates = this.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session.id && !terminal(task.status) && (!agentId || task.agentId === agentId) && (!taskId || task.id === taskId));
        if (candidates.length > 1) throw new Error("存在多个活动任务，请使用 /stop --task <ID>，或 /stop --session <会话>。");
        await this.stop(session, actor, agentId, taskId);
      }
      return { text: "已请求停止，执行状态可通过 /status 查询。", sessionId: session.id };
    }
    if (session.status !== "active") throw new Error("会话已归档或正在删除。请先恢复会话。");
    const steer = command === "/steer";
    if (steer) words.shift();
    else if (command?.startsWith("/") && command !== "--") throw new Error("未知 Gateway 命令。使用 /session、/agent、/history、/status、/stop 或 /steer。");
    if (words[0] === "--") words.shift();
    const body = parsed.body ?? words.join(" ");
    if (!body.trim()) throw new Error("消息正文不能为空。");
    const previousAdmission = this.inputAdmissions.get(session.id) ?? Promise.resolve();
    let releaseAdmission!: () => void;
    const ownAdmission = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const admissionChain = previousAdmission.then(() => ownAdmission);
    this.inputAdmissions.set(session.id, admissionChain);
    await previousAdmission;
    try {
    const agents = agentId ? [agentId] : session.defaultAgents;
    for (const id of agents) this.authorizeAgent(id, actor, session.entry);
    await Promise.all(agents.map(id => this.resolveAdapter(id)));
    if (this.closing) throw new Error("Gateway 正在关闭。");
    if (this.session(session.id, actor).status !== "active") throw new Error("会话当前不可接收输入。");
    if (steer && agents.length !== 1) throw new Error("请使用 @Agent 明确补充信息的目标。");
    const active = this.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session.id && agents.includes(task.agentId) && !terminal(task.status));
    for (const task of active) if (!this.isAdmin(session, actor) && actorKey(task.actor) !== actorKey(actor)) throw new Error("目标 Agent 正在处理其他成员的工作。");
    if (steer && active.length) {
      const id = agents[0]!, adapter = await this.resolveAdapter(id), binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${id}`);
      if (binding?.status !== "ready" || !binding.conversationId) throw new Error("Agent 对话尚未就绪，请等待创建或审批完成。");
      if (!adapter.capabilities.steer || !adapter.steer) throw new Error("此 Agent 不支持 /steer。");
      const steeringId = digest({ actor: actorKey(actor), requestId: input.requestId, session: session.id, agent: id });
      const message = this.record(session, { kind: "user", text: body, actor, agentId: id }, actor.kind === "operator");
      const intent = { id: steeringId, sessionId: session.id, agentId: id, actor, text: body, messageId: message.id, status: "sending" };
      this.store.put("steering", steeringId, intent);
      const result = await adapter.steer(binding.conversationId!, body, steeringId);
      this.store.put("steering", steeringId, { ...intent, status: result.status });
      return { text: `补充信息状态：${result.status}`, sessionId: session.id };
    }
    for (const task of active) {
      const adapter = await this.resolveAdapter(task.agentId);
      if (!adapter.capabilities.cancel) throw new Error(`Agent ${task.agentId} 不支持中断，请等待当前执行结束。`);
    }
    for (const task of active) await this.stop(session, actor, undefined, task.id);
    if (this.session(session.id, actor).status !== "active") throw new Error("会话当前不可接收输入。");
    for (const id of agents) this.authorizeAgent(id, actor, session.entry);
    if (this.store.list<GatewayTask>("tasks").some(task => task.sessionId === session.id && agents.includes(task.agentId) && !terminal(task.status))) throw new Error("原执行尚未确认结束，请查询 /status 后处理恢复事项。");
    const steering = input.steeringInputId ? this.store.get<{ messageId: string }>("steering", input.steeringInputId) : undefined;
    const priorSteer = steering ? this.store.get<GatewayMessage>("messages", steering.messageId) : undefined;
    const message = priorSteer ?? this.record(session, { kind: "user", text: body, actor, ...(input.content ? { content: input.content } : {}), ...(input.messageId ? { sourceMessageId: input.messageId } : {}), ...(input.entry ? { sourceEntry: entryKey(input.entry) } : {}) }, actor.kind === "operator");
    if (input.entry && input.messageId) { const id = `${entryKey(input.entry)}:${input.messageId}`; this.store.put("platform-messages", id, { id, sessionId: session.id }); }
    const graphId = digest({ requestId: input.requestId, actor: actorKey(actor) });
    this.store.put("graphs", graphId, { id: graphId, sessionId: session.id, actor, messageId: message.id, ...(input.content ? { content: input.content } : {}), ...(input.steeringInputId ? { rootInputId: input.steeringInputId } : {}) } satisfies GraphRecord);
    if (this.closing) throw new Error("Gateway 正在关闭。");
    const runtime = await (await this.pluginHost()).get(coordinationService).create({ id: graphId, store: this.coordinationStore(), agents: this.coordinationAgents(session, actor, graphId),
      policy: this.policy(session, actor), tasks: agents.map((id, index) => ({ id: `request-${index}`, agent: id, input: body })),
      limits: { maxConcurrent: this.options.settings.maxConcurrent, maxTasks: 64, maxTaskTurns: 32, maxDurationMs: 3_600_000 } });
    this.launch(runtime, graphId);
    await runtime.start();
    return { text: `已接受输入：${session.name}\nAgent：${agents.join(", ")}`, sessionId: session.id, taskIds: agents.map((_, index) => `${graphId}:request-${index}`) };
    } finally { releaseAdmission(); if (this.inputAdmissions.get(session.id) === admissionChain) this.inputAdmissions.delete(session.id); }
  }
  private coordinationStore(): CoordinationStore {
    return { acquire: async id => ({ read: async () => this.store.get<CoordinationSnapshot>("coordination", id),
      commit: async (snapshot, revision) => { this.store.transaction(() => { const prior = this.store.get<CoordinationSnapshot>("coordination", id); if ((prior?.revision ?? 0) !== revision) throw new Error("协作记录版本冲突。"); this.store.put("coordination", id, snapshot); }); }, close: async () => {} }) };
  }
  private policy(session: GatewaySession, actor: GatewayActor) {
    const versions = new Map(this.options.settings.agents.map(agent => [agent.id, digest(agent)]));
    const accepted = new Set(this.options.settings.agents.filter(agent => !this.reconfiguring.has(agent.id)).map(agent => agent.id));
    const authorized = (agent: string) => { const current = this.store.get<GatewaySession>("sessions", session.id), config = this.options.settings.agents.find(item => item.id === agent); if (!current || !this.canAccess(current, actor) || current.status !== "active" || !config || versions.get(agent) !== digest(config)) return false; this.authorizeAgent(agent, actor, current.entry, accepted.has(agent)); return true; };
    return { version: digest(this.options.settings.access), authorize: (task: { agent: string }) => authorized(task.agent),
      authorizeDelegation: (_parent: unknown, child: { agent: string }) => authorized(child.agent),
      authorizeMessage: (sender: { agent: string }, recipient: { agent: string }) => authorized(sender.agent) && authorized(recipient.agent),
      authorizeHandoff: (_source: unknown, target: { agent: string }) => authorized(target.agent) };
  }
  private coordinationAgents(session: GatewaySession, actor: GatewayActor, graphId: string): Record<string, CoordinationAgent> {
    return Object.fromEntries(this.options.settings.agents.map(config => [config.id, {
      version: digest(config),
      execute: async (execution, context) => {
        const graphRecord = this.store.get<GraphRecord>("graphs", graphId);
        const taskId = `${graphId}:${execution.task.id}`, inputId = graphRecord?.rootInputId && !execution.task.parentTaskId && (execution.task.turn ?? 0) === 0 ? graphRecord.rootInputId : `${execution.task.dispatchId}:${execution.task.turn ?? 0}`;
        const task: GatewayTask = { id: taskId, sessionId: session.id, agentId: config.id, graphId, graphTaskId: execution.task.id, actor, input: execution.task.input,
          inputId, status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
        this.store.put("tasks", taskId, task); this.changed();
        let failureReported = false;
        let finishTask!: () => void;
        const taskJob = new Promise<void>(resolve => { finishTask = resolve; }); this.taskJobs.set(taskId, taskJob);
        try {
        const current = this.session(session.id, actor);
        const existing = this.store.get<GatewayBinding>("bindings", `${session.id}:${config.id}`);
        if (!existing && !current.allowedAgents.includes(config.id)) {
          const approval = this.requestApproval(current, config.id, actor, "create-agent", inputId, `创建 ${config.id} 对话`, taskId);
          this.store.put("tasks", taskId, { ...task, status: "waiting" });
          const allowed = await new Promise<boolean>(resolve => {
            this.approvalWaiters.set(approval.id, resolve);
            const abort = () => { this.approvalWaiters.delete(approval.id); resolve(false); };
            context.signal.addEventListener("abort", abort, { once: true });
            if (context.signal.aborted) abort();
          });
          if (!allowed) {
            this.cancelApprovals(taskId); finishTask(); this.taskJobs.delete(taskId);
            this.store.put("tasks", taskId, { ...task, status: context.signal.aborted ? "cancelled" : "failed", detail: "创建 Agent 对话的审批未通过。" });
            throw new Error("创建 Agent 对话的审批未通过。");
          }
        }
        context.signal.throwIfAborted();
        const binding = await this.binding(current, config.id), adapter = await this.resolveAdapter(config.id);
        const key = binding.id, previous = this.dialogueJobs.get(key) ?? Promise.resolve();
        let release!: () => void;
        const own = new Promise<void>(resolve => { release = resolve; });
        const chain = previous.then(() => own); this.dialogueJobs.set(key, chain);
        await previous;
        let yielded = false, slot = false;
        try {
          await this.acquireSlot(context.signal); slot = true;
          context.signal.throwIfAborted();
          this.activeBindings.set(key, taskId);
          this.store.put("tasks", taskId, { ...task, status: "running" }); this.changed();
          const taskInput = coordinationInput(execution), graph = this.store.get<GraphRecord>("graphs", graphId);
          if (!execution.task.parentTaskId && (execution.task.turn ?? 0) === 0 && graph?.content) taskInput.content.push(...graph.content);
          const tools: Tool[] = adapter.capabilities.collaboration ? [...createCoordinationTools(context, () => { yielded = true; }), {
            name: "list_agents", description: "List registered Agents available to this session before choosing a delegation or handoff target. Shows whether creating its conversation requires approval.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const visible = this.session(session.id, actor);
              const scope = visible.entry ? entryKey(visible.entry) : actorKey(actor);
              const allowed = this.options.settings.access.allowedAgents[scope] ?? this.options.settings.access.allowedAgents[actorKey(actor)];
              return this.options.settings.agents.filter(agent => agent.enabled !== false && (!allowed || allowed.includes(agent.id))).map(agent => ({ id: agent.id, name: agent.name ?? agent.id,
                requiresCreationApproval: !visible.allowedAgents.includes(agent.id) && !this.store.get<GatewayBinding>("bindings", `${visible.id}:${agent.id}`)?.conversationId }));
            },
          }] : [];
          const result = await adapter.execute({ conversationId: binding.conversationId!, inputId, input: taskInput, signal: context.signal,
            permissionScope: JSON.stringify(actor.kind === "operator" ? ["operator", actor.id] : ["platform", actor.account, actor.userId]),
            tools, shouldYield: () => yielded,
            report: event => { context.report(event); this.onEvent(session, task, event); } });
          this.store.transaction(() => {
            this.store.put("bindings", binding.id, { ...binding, usedAt: Date.now() });
            if (result.yielded) this.store.put("tasks", taskId, { ...task, status: "waiting", result: result.text, ...(result.runId ? { runId: result.runId } : {}), updatedAt: Date.now() });
            else this.completeTask(task, result);
          });
          if (result.yielded) return { yielded: true as const };
          return { text: result.text, ...(result.runId ? { runId: result.runId } : {}) };
        } catch (error) {
          const unknown = typeof error === "object" && error !== null && "outcome" in error && error.outcome === "unknown";
          this.store.put("tasks", taskId, { ...task, status: unknown ? "recovery-required" : context.signal.aborted ? "cancelling" : "failed", detail: safeError(error), updatedAt: Date.now() });
          this.record(current, { kind: "notice", text: unknown ? safeError(error) : context.signal.aborted ? "已请求取消，正在核对执行状态。" : safeError(error), agentId: config.id, taskId });
          failureReported = true;
          throw error;
        } finally { if (this.activeBindings.get(key) === taskId) this.activeBindings.delete(key); if (slot) { this.runningCount--; this.slotWaiters.shift()?.(); } release(); if (this.dialogueJobs.get(key) === chain) this.dialogueJobs.delete(key); }
        } catch (error) {
          if (!failureReported) {
            const current = this.store.get<GatewaySession>("sessions", session.id);
            const detail = context.signal.aborted ? "执行已取消。" : `${safeError(error)}\n使用 /agent list 查询，或使用 /agent create <Agent> 尝试创建其他 Agent 对话。`;
            this.store.put("tasks", taskId, { ...task, status: context.signal.aborted ? "cancelled" : "failed", detail, updatedAt: Date.now() });
            if (current) this.record(current, { kind: "notice", text: detail, agentId: config.id, taskId });
          }
          throw error;
        } finally { finishTask(); this.taskJobs.delete(taskId); this.cancelApprovals(taskId); this.changed(); }
      },
      recover: async execution => {
        const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${config.id}`);
        if (!binding?.conversationId) return { status: "not-started" as const };
        const graphRecord = this.store.get<GraphRecord>("graphs", graphId);
        const inputId = graphRecord?.rootInputId && !execution.task.parentTaskId && (execution.task.turn ?? 0) === 0 ? graphRecord.rootInputId : `${execution.task.dispatchId}:${execution.task.turn ?? 0}`;
        const result = await (await this.resolveAdapter(config.id)).inspect(binding.conversationId, inputId);
        if (result.status === "completed") {
          if (!graphRecord) throw new Error("任务的协作记录不存在。");
          this.completeTask(this.projectTask(graphRecord, execution.task), { ...result, text: result.text ?? "" });
          return { status: "completed" as const, output: { text: result.text ?? "", ...(result.runId ? { runId: result.runId } : {}) } };
        }
        if (result.status === "not-started") return { status: "not-started" as const };
        if (result.status === "waiting") return { status: "yielded" as const };
        if (result.status === "failed" || result.status === "cancelled") return { status: result.status, detail: result.detail ?? result.status };
        return { status: "recovery-required" as const, detail: result.detail ?? "执行结果需要核对。" };
      },
    } satisfies CoordinationAgent]));
  }
  private launch(runtime: CoordinationRuntime, id: string): void {
    this.graphs.set(id, runtime);
    const relay = (async () => { for await (const event of runtime.events) if (event.type === "state.changed") {
      for (const task of event.snapshot.tasks) {
        const key = `${id}:${task.id}`, current = this.store.get<GatewayTask>("tasks", key);
        if (current) this.store.put("tasks", key, { ...current, status: task.status, ...(task.detail ? { detail: task.detail } : {}), updatedAt: Date.now() });
      }
      this.changed();
    } })();
    this.relays.set(id, relay);
    void relay.finally(() => this.relays.delete(id)).catch(error => { this.error = safeError(error); });
    let closed = false;
    const job = runtime.wait().then(async snapshot => {
      if (snapshot.tasks.every(task => terminal(task.status)) || snapshot.tasks.some(task => task.status === "recovery-required")) { await (await this.pluginHost()).get(coordinationService).release(runtime); await relay; closed = true; }
    })
      .catch(error => { this.error = safeError(error); this.changed(); })
      .finally(() => { if (closed) this.graphs.delete(id); this.jobs.delete(id); });
    this.jobs.set(id, job);
  }
  private async acquireSlot(signal: AbortSignal): Promise<void> {
    while (this.runningCount >= this.options.settings.maxConcurrent) {
      await new Promise<void>(resolve => { this.slotWaiters.push(resolve); signal.addEventListener("abort", () => { const index = this.slotWaiters.indexOf(resolve); if (index >= 0) this.slotWaiters.splice(index, 1); resolve(); }, { once: true }); });
      signal.throwIfAborted();
    }
    signal.throwIfAborted(); this.runningCount++;
  }
  async recoverTask(taskId: string, actor: GatewayActor): Promise<GatewayTask> {
    const task = this.store.get<GatewayTask>("tasks", taskId);
    if (!task) throw new Error("任务不存在。");
    const session = this.session(task.sessionId, actor); this.requireAdmin(session, actor);
    const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${task.agentId}`);
    if (!binding?.conversationId) throw new Error("Agent 对话尚未确认。");
    const outcome = await (await this.resolveAdapter(task.agentId)).inspect(binding.conversationId, task.inputId);
    if (outcome.status === "not-started") return task;
    if (outcome.status === "completed") return this.completeTask(task, { ...outcome, text: outcome.text ?? "" });
    const updated: GatewayTask = { ...task, status: outcome.status, ...(outcome.text ? { result: outcome.text } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}), updatedAt: Date.now() };
    this.store.put("tasks", taskId, updated); this.changed(); return updated;
  }
  retryDelivery(id: string, actor: GatewayActor, confirmUnknown = false): void {
    if (actor.kind !== "operator") throw new Error("重新发送消息需要服务管理员权限。");
    const collection = this.store.get("deliveries", id) ? "deliveries" : "channel-replies";
    const delivery = this.store.get<{ id: string; status: string } & Record<string, unknown>>(collection, id);
    if (!delivery) throw new Error("消息投递记录不存在。");
    if (delivery.status === "sent" || delivery.status === "sending") throw new Error("该消息正在发送或已经发送。");
    if (delivery.status === "unknown" && !confirmUnknown) throw new Error("发送结果未知，确认可能重复后才能重新发送。");
    this.store.put(collection, id, { ...delivery, status: "pending" }); this.changed();
  }
  async dispatchTask(taskId: string, actor: GatewayActor): Promise<GatewayTask> {
    const task = this.store.get<GatewayTask>("tasks", taskId);
    if (!task) throw new Error("任务不存在。");
    const session = this.session(task.sessionId, actor); this.requireAdmin(session, actor);
    if (terminal(task.status)) return task;
    if (this.graphs.has(task.graphId)) { await this.graphs.get(task.graphId)!.start(); return this.store.get<GatewayTask>("tasks", taskId)!; }
    const graph = this.store.get<GraphRecord>("graphs", task.graphId);
    if (!graph) throw new Error("任务的协作记录不存在。");
    const runtime = await (await this.pluginHost()).get(coordinationService).resume({ id: graph.id, store: this.coordinationStore(), agents: this.coordinationAgents(session, graph.actor, graph.id), policy: this.policy(session, graph.actor) });
    this.launch(runtime, graph.id); return this.store.get<GatewayTask>("tasks", taskId)!;
  }
  async restore(): Promise<void> {
    for (const graph of this.store.list<GraphRecord>("graphs")) {
      const state = this.store.get<CoordinationSnapshot>("coordination", graph.id);
      if (!state) continue;
      validateCoordinationSnapshot(state, graph.id);
      const session = this.store.get<GatewaySession>("sessions", graph.sessionId);
      if (!session) throw new Error(`任务所属会话 ${graph.sessionId} 不存在。`);
      for (const source of state.tasks) if (terminal(source.status)) {
        const task = this.projectTask(graph, source);
        if (source.status === "completed") {
          if (!source.output) throw new Error(`已完成任务 ${task.id} 缺少结果记录。`);
          this.completeTask(task, source.output);
        } else this.store.put("tasks", task.id, { ...task, status: source.status, ...(source.detail ? { detail: source.detail } : {}), updatedAt: Date.now() });
      }
      if (state.tasks.every(task => terminal(task.status))) continue;
      let reason: string | undefined;
      if (!this.canAccess(session, graph.actor)) reason = "发起者的会话访问权限已经撤销，请服务管理员核对原工作。";
      else if (session.status !== "active") reason = "会话当前不可执行，请服务管理员核对恢复状态。";
      else if (state.policyVersion !== digest(this.options.settings.access)) reason = "访问配置版本已经变化，请服务管理员核对原工作的授权范围。";
      else {
        const versions = new Map(this.options.settings.agents.map(agent => [agent.id, digest(agent)]));
        const sources = [...state.tasks, ...(state.graphChanges ?? []).flatMap(change => change.previous), ...state.tasks.flatMap(task => (task.attempts ?? []).map(attempt => attempt.task))];
        for (const source of sources) {
          const owners = [source, ...(source.pendingHandoff ? [source.pendingHandoff] : []), ...(source.handoffs ?? []).flatMap(handoff => [handoff.from, handoff.to])];
          const changed = owners.find(owner => versions.get(owner.agent) !== owner.agentVersion);
          if (changed) { reason = `Agent ${changed.agent} 不存在或配置版本已经变化，请服务管理员核对原工作。`; break; }
        }
      }
      if (reason) {
        this.store.transaction(() => {
          for (const source of state.tasks) if (!terminal(source.status)) {
            const task = this.projectTask(graph, source);
            this.store.put("tasks", task.id, { ...task, status: "recovery-required", detail: reason, updatedAt: Date.now() });
          }
        });
        this.changed(); continue;
      }
      const runtime = await (await this.pluginHost()).get(coordinationService).resume({ id: graph.id, store: this.coordinationStore(), agents: this.coordinationAgents(session, graph.actor, graph.id), policy: this.policy(session, graph.actor) });
      this.launch(runtime, graph.id);
    }
  }
  private projectTask(graph: GraphRecord, source: CoordinationSnapshot["tasks"][number]): GatewayTask {
    const id = `${graph.id}:${source.id}`, prior = this.store.get<GatewayTask>("tasks", id);
    const session = this.store.get<GatewaySession>("sessions", graph.sessionId);
    if (!session) throw new Error(`任务所属会话 ${graph.sessionId} 不存在。`);
    const inputId = graph.rootInputId && !source.parentTaskId && (source.turn ?? 0) === 0 ? graph.rootInputId : `${source.dispatchId}:${source.turn ?? 0}`;
    return { ...prior, id, sessionId: graph.sessionId, agentId: source.agent, graphId: graph.id, graphTaskId: source.id, actor: graph.actor,
      input: source.input, inputId, status: source.status, createdAt: prior?.createdAt ?? this.store.get<GatewayMessage>("messages", graph.messageId)?.createdAt ?? session.createdAt, updatedAt: prior?.updatedAt ?? Date.now() };
  }
  private completeTask(task: GatewayTask, result: { text: string; runId?: string; content?: ContentPart[] }): GatewayTask {
    return this.store.transaction(() => {
      const session = this.store.get<GatewaySession>("sessions", task.sessionId);
      if (!session) throw new Error(`任务所属会话 ${task.sessionId} 不存在。`);
      const { detail: _detail, ...current } = { ...this.store.get<GatewayTask>("tasks", task.id), ...task };
      const completed: GatewayTask = { ...current, status: "completed", result: result.text, ...(result.runId ? { runId: result.runId } : {}), updatedAt: Date.now() };
      this.store.put("tasks", task.id, completed);
      if (!this.store.list<GatewayMessage>("messages").some(message => message.taskId === task.id && message.kind === "assistant")) {
        this.record(session, { kind: "assistant", text: result.text, agentId: task.agentId, taskId: task.id, ...(result.content ? { content: result.content } : {}) });
      }
      return completed;
    });
  }
  private binding(session: GatewaySession, agentId: string): Promise<GatewayBinding> {
    const id = `${session.id}:${agentId}`, prior = this.bindingJobs.get(id); if (prior) return prior;
    const job = this.createBinding(session, agentId); this.bindingJobs.set(id, job);
    void job.finally(() => this.bindingJobs.delete(id)).catch(() => undefined); return job;
  }
  private async createBinding(session: GatewaySession, agentId: string): Promise<GatewayBinding> {
    const id = `${session.id}:${agentId}`, existing = this.store.get<GatewayBinding>("bindings", id);
    if (existing?.status === "ready") return existing;
    const config = this.options.settings.agents.find(agent => agent.id === agentId)!;
    const record: GatewayBinding = existing ?? { id, sessionId: session.id, agentId, requestId: randomUUID(), version: digest(config), status: "creating", usedAt: Date.now() };
    this.store.put("bindings", id, record);
    const adapter = await this.resolveAdapter(agentId);
    if (existing) {
      const result = await adapter.inspectCreation?.(record.requestId);
      if (result?.status === "ready" && result.conversationId) {
        const ready = { ...record, status: "ready" as const, conversationId: result.conversationId };
        this.store.put("bindings", id, ready); return ready;
      }
      if (result?.status !== "not-started") throw new Error("Agent 对话创建结果需要核对，请查询适配器状态。");
    }
    try {
      const conversationId = await adapter.createConversation(record.requestId);
      const ready = { ...record, conversationId, status: "ready" as const };
      this.store.put("bindings", id, ready); return ready;
    } catch (error) { this.store.put("bindings", id, { ...record, status: "unknown", error: safeError(error) }); throw error; }
  }
  private requestApproval(session: GatewaySession, agentId: string, actor: GatewayActor, kind: GatewayApproval["kind"], requestId: string, text: string, taskId?: string, grantKey?: string, persistent?: ApprovalRequest["persistent"]): GatewayApproval {
    const previous = this.store.list<GatewayApproval>("approvals").filter(item => item.sessionId === session.id && item.agentId === agentId && item.requestId === requestId && item.kind === kind);
    const existing = previous.find(item => item.status === "pending"); if (existing) return existing;
    const id = previous.length ? randomUUID() : digest({ session: session.id, agent: agentId, requestId, kind });
    const approval: GatewayApproval = { id, sessionId: session.id, agentId, actor, kind, requestId, text, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + this.options.settings.approvalMs,
      ...(taskId ? { taskId } : {}), ...(grantKey ? { grantKey } : {}), ...(persistent ? { persistent } : {}) };
    this.store.put("approvals", id, approval);
    this.record(session, { kind: "notice", text: `${text}\n审批：/approve ${id} 或 /deny ${id}`, agentId, ...(taskId ? { taskId } : {}) });
    return approval;
  }
  private onEvent(session: GatewaySession, task: GatewayTask, event: AgentApplicationEvent): void {
    const id = `${task.id}:${task.inputId}:${randomUUID()}`;
    this.store.put("events", id, { id, sessionId: session.id, taskId: task.id, event, at: Date.now() });
    if (event.type === "permission.event" && event.event.type === "approval.requested") {
      const request = event.event.request;
      this.requestApproval(session, task.agentId, task.actor, "tool", request.id, `工具 ${request.tool.name} 等待审批。\n参数：${JSON.stringify(request.input)}${request.persistent ? `\n持久规则范围：${request.persistent.description}` : ""}`, task.id, request.grantKey, request.persistent);
    }
    this.changed();
  }
  async resolveApproval(id: string, actor: GatewayActor, decision: ApprovalDecision): Promise<void> {
    if (!["allow", "allow-session", "allow-persistent", "deny"].includes(decision)) throw new TypeError("审批决定无效。");
    const approval = this.store.get<GatewayApproval>("approvals", id);
    if (!approval) throw new Error("审批请求不存在。");
    const session = this.session(approval.sessionId, actor); this.requireAdmin(session, actor);
    if (approval.status !== "pending" || approval.expiresAt <= Date.now()) throw new Error("审批已经处理或已经过期。");
    if (decision === "allow-session" && (approval.kind !== "tool" || !approval.grantKey)) throw new Error("此请求不支持持续授权。");
    if (decision === "allow-persistent" && (actor.kind !== "operator" || !this.options.settings.persistentRules || approval.kind !== "tool" || !approval.persistent)) throw new Error("保存持久权限规则需要服务管理员权限，以及已启用的持久规则范围。");
    if (!this.canAccess(session, approval.actor)) throw new Error("请求发起者的访问权限已失效。");
    this.authorizeAgent(approval.agentId, approval.actor, session.entry, true);
    this.store.put("approvals", id, { ...approval, status: "resolving", decision, decidedBy: actor });
    try {
    if (approval.kind === "create-agent") {
      const waiter = this.approvalWaiters.get(id);
      if (waiter) { this.approvalWaiters.delete(id); waiter(decision !== "deny"); }
      else if (decision !== "deny") await this.binding(session, approval.agentId);
    } else {
      const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${approval.agentId}`), adapter = await this.resolveAdapter(approval.agentId);
      if (!binding?.conversationId || !adapter.resolveApproval || !await adapter.resolveApproval(binding.conversationId, approval.requestId, decision,
        decision === "allow-persistent" ? { createdBy: actorKey(actor) } : undefined)) throw new Error("Agent 已不再等待此审批。");
    }
    this.store.put("approvals", id, { ...approval, status: decision === "deny" ? "denied" : "allowed", decision, decidedBy: actor });
    } catch (error) { this.store.put("approvals", id, { ...approval, status: "unknown", decision, decidedBy: actor }); this.changed(); throw error; }
    this.changed();
  }
  private cancelApprovals(taskId: string): void {
    for (const approval of this.store.list<GatewayApproval>("approvals")) if (approval.taskId === taskId && approval.status === "pending") this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
  }
  async stop(session: GatewaySession, actor: GatewayActor, agentId?: string, taskId?: string): Promise<void> {
    const tasks = this.store.list<GatewayTask>("tasks").filter(task => task.sessionId === session.id && !terminal(task.status) && (!agentId || task.agentId === agentId) && (!taskId || task.id === taskId));
    if (!taskId && !agentId && !this.isAdmin(session, actor) && tasks.length > 1) throw new Error("请使用 /stop --task <ID> 指定任务。");
    for (const task of tasks) {
      if (!this.isAdmin(session, actor) && actorKey(actor) !== actorKey(task.actor)) throw new Error("无权停止其他成员的工作。");
      if (this.activeBindings.get(`${session.id}:${task.agentId}`) === task.id && !(await this.resolveAdapter(task.agentId)).capabilities.cancel) throw new CancellationUnsupportedError(`Agent ${task.agentId} 不支持取消，请等待当前执行结束。`);
      const runtime = this.graphs.get(task.graphId);
      if (runtime) await runtime.cancel(randomUUID(), task.graphTaskId);
      const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${task.agentId}`);
      if (binding?.conversationId && this.activeBindings.get(binding.id) === task.id) await (await this.resolveAdapter(task.agentId)).cancel?.(binding.conversationId);
      await this.taskJobs.get(task.id);
      if (runtime) await new Promise<void>(resolve => {
        let unsubscribe = () => {};
        const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
        const check = () => { const current = this.store.get<GatewayTask>("tasks", task.id); if (!current || terminal(current.status) || current.status === "recovery-required") finish(); };
        const timer = setTimeout(finish, this.options.settings.shutdownMs);
        unsubscribe = this.observe(check); check();
      });
    }
  }
  async manageSession(session: GatewaySession, actor: GatewayActor, action: string, confirmed = false): Promise<void> {
    this.requireAdmin(session, actor);
    if (this.inputAdmissions.has(session.id)) throw new Error("会话正在接收输入，请等待接收完成。");
    if (this.store.list<GatewayTask>("tasks").some(task => task.sessionId === session.id && !terminal(task.status))
      || this.store.list<GatewayApproval>("approvals").some(approval => approval.sessionId === session.id && approval.status === "pending")) throw new Error("会话仍有活动工作或审批，请先停止或等待完成。");
    if (action === "delete") {
      if (!confirmed) throw new Error("删除将清理会话、专用 Agent 对话和未发送消息。添加 --confirm 确认。");
      this.store.put("sessions", session.id, { ...session, status: "deleting" });
      await Promise.all(this.store.list<GraphRecord>("graphs").filter(graph => graph.sessionId === session.id).map(graph => this.jobs.get(graph.id)));
      for (const binding of this.store.list<GatewayBinding>("bindings").filter(item => item.sessionId === session.id)) {
        const adapter = await this.resolveAdapter(binding.agentId);
        if (!adapter.capabilities.delete || !adapter.deleteConversation || !binding.conversationId) throw new Error(`Agent ${binding.agentId} 对话清理尚未完成。`);
        await adapter.deleteConversation(binding.conversationId); this.store.delete("bindings", binding.id);
      }
      this.store.transaction(() => {
        const inputs = new Set<string>();
        const receipts = this.store.entries<{ fingerprint: string; sessionId?: string; result?: GatewayReceipt }>("receipts");
        const receiptIds = new Set(receipts.filter(({ value }) => value.sessionId === session.id || value.result?.sessionId === session.id).map(({ id }) => id));
        for (const { id, value } of this.store.entries<{ sessionId?: string; input: ChannelInput }>("inbox")) {
          const input = value.input;
          const receiptId = digest({ actor: actorKey({ kind: "platform", account: input.account, conversation: input.conversation, userId: input.sender }), requestId: `channel:${id}` });
          const associated = input.messageId && this.store.get<{ sessionId: string }>("platform-messages", `${entryKey(input)}:${input.messageId}`);
          if (value.sessionId === session.id || receiptIds.has(receiptId) || associated && associated.sessionId === session.id) inputs.add(id);
        }
        for (const collection of ["inbox", "channel-replies", "message-changes"]) {
          for (const { id, value } of this.store.entries<{ sessionId?: string; input: ChannelInput }>(collection)) {
            if (value.sessionId === session.id || inputs.has(inboxId(value.input))) this.store.delete(collection, id);
          }
        }
        for (const { id, value } of receipts) if (receiptIds.has(id)) this.store.put("receipts", id, { id, fingerprint: value.fingerprint, error: "原请求所属会话已删除。" });
        for (const graph of this.store.list<GraphRecord>("graphs")) if (graph.sessionId === session.id) this.store.delete("coordination", graph.id);
        for (const collection of ["messages", "tasks", "deliveries", "approvals", "events", "graphs", "platform-messages", "steering", "defaults"]) {
          for (const { id, value } of this.store.entries<{ sessionId: string }>(collection)) if (value.sessionId === session.id) this.store.delete(collection, id);
        }
        this.store.delete("sequences", session.id);
        this.store.delete("sessions", session.id);
      });
    } else this.store.put("sessions", session.id, { ...session, status: action === "restore" ? "active" : "archived", updatedAt: Date.now() });
    this.changed();
  }
  async maintain(): Promise<void> {
    if (this.closing) return;
    let finishMaintenance!: () => void;
    const maintenanceJob = new Promise<void>(resolve => { finishMaintenance = resolve; });
    this.maintenanceJobs.add(maintenanceJob);
    try {
    for (const item of this.store.list<{ id: string; sessionId: string; agentId: string; actor: GatewayActor; text: string; status: string }>("steering")) {
      if (!["pending", "idle", "sending", "starting"].includes(item.status)) continue;
      const session = this.store.get<GatewaySession>("sessions", item.sessionId);
      if (!session || !this.canAccess(session, item.actor) || session.status !== "active") {
        this.store.put("steering", item.id, { ...item, status: "cancelled" }); continue;
      }
      const binding = this.store.get<GatewayBinding>("bindings", `${item.sessionId}:${item.agentId}`);
      if (!binding?.conversationId || this.dialogueJobs.has(binding.id)) continue;
      const adapter = await this.resolveAdapter(item.agentId), state = (await adapter.steeringInputs?.(binding.conversationId))?.find(input => input.inputId === item.id);
      if (!state) continue;
      if (state.status === "idle") {
        this.store.put("steering", item.id, { ...item, status: "starting" });
        try { await this.handle(`@${item.agentId} -- ${item.text}`, item.actor, { requestId: `steering:${item.id}`, sessionId: item.sessionId, steeringInputId: item.id }); }
        catch (error) {
          this.store.put("steering", item.id, { ...item, status: "unknown", detail: safeError(error) });
          this.record(this.session(item.sessionId, item.actor), { kind: "notice", agentId: item.agentId, text: `补充信息需要核对：${safeError(error)}` });
          continue;
        }
        this.store.put("steering", item.id, { ...item, status: "delivered" });
      } else if (state.status === "delivered" || state.status === "cancelled") {
        this.store.put("steering", item.id, { ...item, status: state.status });
        if (state.status === "cancelled") this.record(this.session(item.sessionId, item.actor), { kind: "notice", agentId: item.agentId, text: `补充信息未交付：${item.text}` });
      }
    }
    for (const approval of this.store.list<GatewayApproval>("approvals")) if (approval.status === "pending" && approval.expiresAt <= Date.now()) {
      if (approval.kind === "tool") { const binding = this.store.get<GatewayBinding>("bindings", `${approval.sessionId}:${approval.agentId}`); if (binding?.conversationId) await (await this.resolveAdapter(approval.agentId)).resolveApproval?.(binding.conversationId, approval.requestId, "deny"); }
      this.store.put("approvals", approval.id, { ...approval, status: "expired" }); this.approvalWaiters.get(approval.id)?.(false); this.approvalWaiters.delete(approval.id); this.changed();
    }
    for (const [id, pending] of this.adapters) {
      if (this.closing || this.reconfiguring.has(id) || this.adapterClosings.has(id) || this.inputAdmissions.size) continue;
      const adapter = await pending;
      if (!adapter.capabilities.resume) continue;
      const bindings = this.store.list<GatewayBinding>("bindings").filter(binding => binding.agentId === id);
      const busy = () => this.inputAdmissions.size > 0 || this.store.list<GatewayTask>("tasks").some(task => task.agentId === id && !terminal(task.status))
        || this.store.list<GatewayApproval>("approvals").some(approval => approval.agentId === id && ["pending", "resolving", "unknown"].includes(approval.status))
        || this.store.list<{ agentId: string; status: string }>("steering").some(item => item.agentId === id && ["pending", "idle", "sending", "starting", "unknown"].includes(item.status))
        || bindings.some(binding => binding.status !== "ready" || !binding.conversationId || this.bindingJobs.has(binding.id) || this.dialogueJobs.has(binding.id));
      if (busy()) continue;
      const config = this.options.settings.agents.find(agent => agent.id === id), idleMs = config?.idleMs ?? this.options.settings.idleMs;
      const idle = bindings.filter(binding => Date.now() - binding.usedAt >= idleMs);
      if (idle.length === bindings.length && Date.now() - (this.adapterUsedAt.get(id) ?? Date.now()) >= idleMs) {
        await this.closeAdapter(id, pending, idle);
      } else for (const binding of idle) {
        if (busy()) break;
        await adapter.release?.(binding.conversationId!);
      }
    }
    } finally { finishMaintenance(); this.maintenanceJobs.delete(maintenanceJob); }
  }
  private closeAdapter(id: string, pending: Promise<GatewayAgentAdapter>, bindings: GatewayBinding[] = []): Promise<void> {
    const current = this.adapterClosings.get(id);
    if (current) return current;
    const close = (async () => {
      const adapter = await pending;
      for (const binding of bindings) await adapter.release?.(binding.conversationId!);
      await (await this.pluginHost()).get(agentAdapterRegistryService).release(id);
      if (this.adapters.get(id) === pending) this.adapters.delete(id);
      this.adapterStates.delete(id);
      this.adapterUsedAt.delete(id);
    })();
    this.adapterClosings.set(id, close);
    void close.finally(() => { if (this.adapterClosings.get(id) === close) this.adapterClosings.delete(id); this.changed(); }).catch(() => undefined);
    return close;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      const settle = async (operations: readonly Promise<unknown>[]) => {
        for (const result of await Promise.allSettled(operations)) if (result.status === "rejected") errors.push(result.reason);
      };
      const wait = (async () => {
        await Promise.allSettled([...this.admission.values()].map(item => item.job));
        await settle([...this.jobs.values()]);
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([wait, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.settings.shutdownMs); })]); }
      finally { if (timer) clearTimeout(timer); }
      await settle([...this.graphs.values()].map(async runtime => (await this.pluginHost()).get(coordinationService).release(runtime)));
      await Promise.allSettled([...this.admission.values()].map(item => item.job));
      await settle([...this.graphs.values()].map(async runtime => (await this.pluginHost()).get(coordinationService).release(runtime)));
      await settle([...this.jobs.values()]);
      await settle([...this.relays.values()]);
      await Promise.allSettled([...this.bindingJobs.values()]);
      try {
        for (const approval of this.store.list<GatewayApproval>("approvals")) if (approval.status === "pending") this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
        this.changed();
      } catch (error) { errors.push(error); }
      await settle([...this.configurationJobs, ...this.maintenanceJobs]);
      await settle([this.configurationWrite]);
      await settle([...this.adapterClosings.values()]);
      await settle([...this.adapters].map(([id, adapter]) => this.closeAdapter(id, adapter)));
      if (this.plugins) await settle([this.plugins.then(host => host.close())]);
      if (this.permissionStore && errors.length === 0) await settle([this.permissionStore.then(store => store.close())]);
      try { this.store.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError([...new Set(errors)], "Gateway cleanup failed");
    })();
    this.changed();
    return this.closePromise;
  }
}
function safeError(error: unknown): string { return error instanceof Error ? error.message : "Gateway 操作失败。"; }
