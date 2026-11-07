import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { recordGatewayMessage } from "./gateway/messages.js";
import * as inputs from "./gateway/input.js";
import * as approvals from "./gateway/approvals.js";
import * as coordination from "./gateway/coordination.js";
import * as maintenance from "./gateway/maintenance.js";
import * as tasks from "./gateway/tasks.js";
import * as management from "./gateway/management.js";
import { CancellationUnsupportedError } from "./gateway/management.js";
import * as permissions from "./gateway/permissions.js";
import * as adapters from "./gateway/adapters.js";
import type { ChannelInput } from "./channel-store.js";
import type {
  CoordinationRuntime,
  CoordinationAgent,
  CoordinationStore,
  CoordinationSnapshot,
} from "@sortedyuan/coordination";
import type { AgentApplicationEvent } from "@sortedyuan/may";
import type { ApprovalDecision, ApprovalRequest, PersistentPermissionRule } from "@sortedyuan/may/permissions";
import { FilePermissionRuleStore } from "@sortedyuan/may/permissions/file-store";
import type { ContentPart } from "@sortedyuan/may/core";
import { PluginHost } from "@sortedyuan/may/plugin";
import { coordinationService } from "@sortedyuan/coordination/plugin";
import { createGatewayAgentPlugins } from "./plugins/agents.js";
import { GatewayStore } from "./gateway-store.js";
import {
  GatewayRepository,
  type GatewayChannelRepository,
  type GatewayEventRecord,
  type PendingInput,
} from "./gateway-repository.js";
import { GatewayAccess } from "./gateway/access.js";
import { projectTask, type GraphRecord } from "./gateway/task-projection.js";
import {
  actorKey,
  digest,
  entryKey,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayApproval,
  type GatewayBinding,
  type GatewayDelivery,
  type GatewayEntry,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
  type GatewayTask,
} from "./gateway-types.js";

export interface GatewayInput {
  requestId: string;
  sessionId?: string;
  entry?: GatewayEntry;
  messageId?: string;
  replyTo?: string;
  content?: ContentPart[];
  steeringInputId?: string;
}
export interface GatewayReceipt {
  text: string;
  sessionId?: string;
  taskIds?: string[];
}
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);

export class AgentGateway {
  private readonly store: GatewayStore;
  private readonly repository: GatewayRepository;
  private readonly access: GatewayAccess;
  readonly channels: GatewayChannelRepository;
  readonly options: { directory: string; configPath: string; settings: GatewaySettings };
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
  constructor(options: { directory: string; configPath: string; settings: GatewaySettings; store?: GatewayStore }) {
    this.options = { directory: options.directory, configPath: options.configPath, settings: options.settings };
    this.store = options.store ?? GatewayStore.open(options.directory);
    this.repository = new GatewayRepository(this.store);
    this.access = new GatewayAccess(this.store, this.options.settings, this.reconfiguring);
    this.channels = this.repository;
    this.repository.recoverDeliveries();
    for (const approval of this.store.list<GatewayApproval>("approvals")) {
      if (approval.status === "pending") this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
      else if (approval.status === "resolving")
        this.store.put("approvals", approval.id, { ...approval, status: "unknown" });
    }
  }
  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  tasks(actor: GatewayActor, sessionId?: string): GatewayTask[] {
    return this.visibleRecords("tasks", actor, sessionId);
  }
  task(id: string, actor: GatewayActor): GatewayTask | undefined {
    const task = this.store.get<GatewayTask>("tasks", id);
    if (task) this.session(task.sessionId, actor);
    return task;
  }
  approvals(actor: GatewayActor, sessionId?: string): GatewayApproval[] {
    return this.visibleRecords("approvals", actor, sessionId);
  }
  bindings(actor: GatewayActor, sessionId?: string): GatewayBinding[] {
    return this.visibleRecords("bindings", actor, sessionId);
  }
  deliveries(actor: GatewayActor, sessionId?: string): GatewayDelivery[] {
    return this.visibleRecords("deliveries", actor, sessionId);
  }
  delivery(id: string, actor: GatewayActor) {
    this.requireOperator(actor);
    return this.repository.delivery(id) ?? this.repository.reply(id);
  }
  events(sessionId: string, actor: GatewayActor): GatewayEventRecord[] {
    return this.visibleRecords("events", actor, sessionId);
  }
  coordinationSnapshots(actor: GatewayActor): CoordinationSnapshot[] {
    this.requireOperator(actor);
    return this.store.list("coordination");
  }
  entryDefaults(actor: GatewayActor): { sessionId: string }[] {
    this.requireOperator(actor);
    return this.store.list("defaults");
  }
  configuration(actor: GatewayActor): GatewaySettings {
    this.requireOperator(actor);
    return structuredClone(this.options.settings);
  }
  private requireOperator(actor: GatewayActor): void {
    this.access.requireOperator(actor);
  }
  private visibleRecords<T extends { sessionId: string }>(
    collection: string,
    actor: GatewayActor,
    sessionId?: string,
  ): T[] {
    return this.access.visibleRecords(collection, actor, sessionId);
  }
  private pluginHost(): Promise<PluginHost> {
    return (this.plugins ??= PluginHost.create({
      plugins: createGatewayAgentPlugins({ ...this.options, permissionRuleStore: () => this.ruleStore() }),
    }));
  }
  private ruleStore(): Promise<FilePermissionRuleStore> {
    if (this.closing) return Promise.reject(new Error("Gateway 正在关闭。"));
    if (!this.options.settings.persistentRules) return Promise.reject(new Error("持久权限规则尚未启用。"));
    return (this.permissionStore ??= FilePermissionRuleStore.open({
      path: join(this.options.directory, "permission-rules.json"),
    }));
  }
  async listPermissionRules(actor: GatewayActor): Promise<readonly PersistentPermissionRule[]> {
    return permissions.listPermissionRules.call(this.permissionOwner(), actor);
  }
  async revokePermissionRule(id: string, actor: GatewayActor): Promise<boolean> {
    return permissions.revokePermissionRule.call(this.permissionOwner(), id, actor);
  }
  async createPermissionRule(
    sourceId: string,
    decision: "allow" | "deny",
    actor: GatewayActor,
  ): Promise<PersistentPermissionRule> {
    return permissions.createPermissionRule.call(this.permissionOwner(), sourceId, decision, actor);
  }
  private permissionOwner(): permissions.GatewayPermissionOwner {
    return {
      store: this.store,
      options: this.options,
      ruleStore: this.ruleStore.bind(this),
      changed: this.changed.bind(this),
    };
  }
  changed(): void {
    for (const listener of this.listeners) listener();
  }
  status() {
    return {
      state: this.closing ? "stopping" : this.error ? "degraded" : "running",
      error: this.error,
      agents: this.options.settings.agents.map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        enabled: agent.enabled !== false,
        status: this.reconfiguring.has(agent.id)
          ? "reconfiguring"
          : agent.enabled === false
            ? "disabled"
            : this.adapterClosings.has(agent.id)
              ? "releasing"
              : (this.adapterStates.get(agent.id) ?? "unloaded"),
      })),
      active: this.store.list<GatewayTask>("tasks").filter((task) => !terminal(task.status)).length,
    };
  }
  async adapter(id: string): Promise<GatewayAgentAdapter> {
    if (this.closing) throw new Error("Gateway is closing");
    await this.adapterClosings.get(id);
    if (this.closing) throw new Error("Gateway is closing");
    return this.resolveAdapter(id);
  }
  private async resolveAdapter(id: string): Promise<GatewayAgentAdapter> {
    return adapters.resolveAdapter.call(this.adapterOwner(), id);
  }
  canAccess(session: GatewaySession, actor: GatewayActor): boolean {
    return this.access.canAccess(session, actor);
  }
  async setMemberAccess(entry: GatewayEntry, userId: string, active: boolean, occurredAt = Date.now()): Promise<void> {
    return management.setMemberAccess.call(this.managementOwner(), entry, userId, active, occurredAt);
  }
  isAdmin(session: GatewaySession, actor: GatewayActor): boolean {
    return this.access.isAdmin(session, actor);
  }
  sessions(actor: GatewayActor): GatewaySession[] {
    return this.access.sessions(actor);
  }
  session(id: string, actor: GatewayActor): GatewaySession {
    return this.access.session(id, actor);
  }
  messages(id: string, actor: GatewayActor): GatewayMessage[] {
    this.session(id, actor);
    return this.store
      .list<GatewayMessage>("messages")
      .filter((message) => message.sessionId === id)
      .sort((a, b) => a.seq - b.seq);
  }
  resolveTargets(
    text: string,
    actor: GatewayActor,
    input: GatewayInput,
  ): { session: GatewaySession; agents: string[] } {
    return inputs.resolveTargets.call(this.inputOwner(), text, actor, input);
  }
  createSession(
    actor: GatewayActor,
    name: string,
    agents: string[],
    allowed: string[] = [],
    entry?: GatewayEntry,
  ): GatewaySession {
    const session = this.access.createSession(actor, name, agents, allowed, entry);
    this.changed();
    return session;
  }
  private authorizeAgent(id: string, actor: GatewayActor, entry?: GatewayEntry, acceptedWork = false): void {
    this.access.authorizeAgent(id, actor, entry, acceptedWork);
  }
  private requireAdmin(session: GatewaySession, actor: GatewayActor): void {
    this.access.requireAdmin(session, actor);
  }
  updateSession(
    id: string,
    actor: GatewayActor,
    update: {
      name?: string;
      defaultAgents?: string[];
      allowedAgents?: string[];
      entry?: GatewayEntry;
      confirmBinding?: boolean;
    },
  ): GatewaySession {
    const result = this.access.updateSession(id, actor, update);
    this.changed();
    return result;
  }
  async setSessionAdmins(id: string, actor: GatewayActor, keys: string[]): Promise<void> {
    return management.setSessionAdmins.call(this.managementOwner(), id, actor, keys);
  }
  async updateAgent(
    id: string,
    actor: GatewayActor,
    config: import("./gateway-types.js").GatewayAgentConfig | null,
  ): Promise<void> {
    return management.updateAgent.call(this.managementOwner(), id, actor, config);
  }
  private waitForAgentApprovals(id: string): Promise<void> {
    return approvals.waitForAgentApprovals.call(this.approvalOwner(), id);
  }
  private record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver = true,
  ): GatewayMessage {
    return recordGatewayMessage(this.store, this.repository, session, data, deliver, () => this.changed());
  }
  recordChannelChange(input: ChannelInput, originalState: PendingInput["state"], sessionId?: string): void {
    if ((input.eventType !== "edit" && input.eventType !== "delete") || !input.messageId)
      throw new Error("平台消息变更需要有效的类型和原消息 ID。");
    this.repository.recordMessageChange(input, originalState, sessionId, (session) => {
      const actor: GatewayActor = {
        kind: "platform",
        account: input.account,
        conversation: input.conversation,
        userId: input.sender,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      };
      const text =
        input.eventType === "delete"
          ? `${actorKey(actor)} 已撤回平台消息 ${input.messageId}。原执行输入继续保存在历史中。`
          : `${actorKey(actor)} 已编辑平台消息 ${input.messageId}。\n最新正文：\n${input.text}`;
      const notice = this.record(
        session,
        { kind: "notice", text, actor, sourceMessageId: input.messageId!, sourceEntry: entryKey(input) },
        false,
      );
      return notice.id;
    });
    this.changed();
  }
  handle(text: string, actor: GatewayActor, input: GatewayInput): Promise<GatewayReceipt> {
    return inputs.handle.call(this.inputOwner(), text, actor, input);
  }
  private inputOwner(): inputs.GatewayInputOwner {
    const owner = this;
    return {
      store: this.store,
      repository: this.repository,
      options: this.options,
      inputAdmissions: this.inputAdmissions,
      admission: this.admission,
      get closing() {
        return owner.closing;
      },
      sessions: this.sessions.bind(this),
      session: this.session.bind(this),
      createSession: this.createSession.bind(this),
      manageSession: this.manageSession.bind(this),
      changed: this.changed.bind(this),
      status: this.status.bind(this),
      messages: this.messages.bind(this),
      resolveApproval: this.resolveApproval.bind(this),
      isAdmin: this.isAdmin.bind(this),
      stop: this.stop.bind(this),
      requireAdmin: this.requireAdmin.bind(this),
      authorizeAgent: this.authorizeAgent.bind(this),
      requestApproval: this.requestApproval.bind(this),
      binding: this.binding.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      record: this.record.bind(this),
      pluginHost: this.pluginHost.bind(this),
      coordinationStore: this.coordinationStore.bind(this),
      coordinationAgents: this.coordinationAgents.bind(this),
      policy: this.policy.bind(this),
      launch: this.launch.bind(this),
    };
  }
  private coordinationStore(): CoordinationStore {
    return coordination.coordinationStore.call(this.coordinationOwner());
  }
  private policy(session: GatewaySession, actor: GatewayActor) {
    return coordination.policy.call(this.coordinationOwner(), session, actor);
  }
  private coordinationAgents(
    session: GatewaySession,
    actor: GatewayActor,
    graphId: string,
  ): Record<string, CoordinationAgent> {
    return coordination.coordinationAgents.call(this.coordinationOwner(), session, actor, graphId);
  }
  private launch(runtime: CoordinationRuntime, id: string): void {
    coordination.launch.call(this.coordinationOwner(), runtime, id);
  }
  private coordinationOwner(): coordination.GatewayCoordinationOwner {
    const owner = this;
    return {
      store: this.store,
      options: this.options,
      reconfiguring: this.reconfiguring,
      graphs: this.graphs,
      jobs: this.jobs,
      relays: this.relays,
      taskJobs: this.taskJobs,
      dialogueJobs: this.dialogueJobs,
      activeBindings: this.activeBindings,
      slotWaiters: this.slotWaiters,
      approvalWaiters: this.approvalWaiters,
      get runningCount() {
        return owner.runningCount;
      },
      set runningCount(value) {
        owner.runningCount = value;
      },
      get error() {
        return owner.error;
      },
      set error(value) {
        owner.error = value;
      },
      session: this.session.bind(this),
      canAccess: this.canAccess.bind(this),
      changed: this.changed.bind(this),
      authorizeAgent: this.authorizeAgent.bind(this),
      requestApproval: this.requestApproval.bind(this),
      cancelApprovals: this.cancelApprovals.bind(this),
      binding: this.binding.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      record: this.record.bind(this),
      pluginHost: this.pluginHost.bind(this),
      onEvent: this.onEvent.bind(this),
      projectTask: this.projectTask.bind(this),
      completeTask: this.completeTask.bind(this),
    };
  }
  async recoverTask(taskId: string, actor: GatewayActor): Promise<GatewayTask> {
    return tasks.recoverTask.call(this.taskOwner(), taskId, actor);
  }
  retryDelivery(id: string, actor: GatewayActor, confirmUnknown = false) {
    return tasks.retryDelivery.call(this.taskOwner(), id, actor, confirmUnknown);
  }
  async dispatchTask(taskId: string, actor: GatewayActor): Promise<GatewayTask> {
    return tasks.dispatchTask.call(this.taskOwner(), taskId, actor);
  }
  async restore(): Promise<void> {
    return tasks.restore.call(this.taskOwner());
  }
  private taskOwner(): tasks.GatewayTaskOwner {
    return {
      store: this.store,
      repository: this.repository,
      options: this.options,
      graphs: this.graphs,
      session: this.session.bind(this),
      canAccess: this.canAccess.bind(this),
      changed: this.changed.bind(this),
      requireAdmin: this.requireAdmin.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      record: this.record.bind(this),
      pluginHost: this.pluginHost.bind(this),
      coordinationStore: this.coordinationStore.bind(this),
      coordinationAgents: this.coordinationAgents.bind(this),
      policy: this.policy.bind(this),
      launch: this.launch.bind(this),
    };
  }
  private projectTask(graph: GraphRecord, source: CoordinationSnapshot["tasks"][number]): GatewayTask {
    return projectTask(this.store, graph, source);
  }
  private completeTask(
    task: GatewayTask,
    result: { text: string; runId?: string; content?: ContentPart[] },
  ): GatewayTask {
    return tasks.finishTask.call(this.taskOwner(), task, result);
  }
  private binding(session: GatewaySession, agentId: string): Promise<GatewayBinding> {
    return adapters.binding.call(this.adapterOwner(), session, agentId);
  }
  private adapterOwner(): adapters.GatewayAdapterOwner {
    return {
      store: this.store,
      options: this.options,
      adapters: this.adapters,
      adapterStates: this.adapterStates,
      adapterClosings: this.adapterClosings,
      adapterUsedAt: this.adapterUsedAt,
      bindingJobs: this.bindingJobs,
      pluginHost: this.pluginHost.bind(this),
      changed: this.changed.bind(this),
    };
  }
  private requestApproval(
    session: GatewaySession,
    agentId: string,
    actor: GatewayActor,
    kind: GatewayApproval["kind"],
    requestId: string,
    text: string,
    taskId?: string,
    grantKey?: string,
    persistent?: ApprovalRequest["persistent"],
  ): GatewayApproval {
    return approvals.requestApproval.call(
      this.approvalOwner(),
      session,
      agentId,
      actor,
      kind,
      requestId,
      text,
      taskId,
      grantKey,
      persistent,
    );
  }
  private onEvent(session: GatewaySession, task: GatewayTask, event: AgentApplicationEvent): void {
    approvals.onEvent.call(this.approvalOwner(), session, task, event);
  }
  async resolveApproval(id: string, actor: GatewayActor, decision: ApprovalDecision): Promise<void> {
    return approvals.resolveApproval.call(this.approvalOwner(), id, actor, decision);
  }
  private cancelApprovals(taskId: string): void {
    approvals.cancelApprovals.call(this.approvalOwner(), taskId);
  }
  private approvalOwner(): approvals.GatewayApprovalOwner {
    const owner = this;
    return {
      store: this.store,
      options: this.options,
      approvalWaiters: this.approvalWaiters,
      get closing() {
        return owner.closing;
      },
      observe: this.observe.bind(this),
      session: this.session.bind(this),
      canAccess: this.canAccess.bind(this),
      changed: this.changed.bind(this),
      requireAdmin: this.requireAdmin.bind(this),
      authorizeAgent: this.authorizeAgent.bind(this),
      binding: this.binding.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      record: this.record.bind(this),
    };
  }
  async stop(session: GatewaySession, actor: GatewayActor, agentId?: string, taskId?: string): Promise<void> {
    const tasks = this.store
      .list<GatewayTask>("tasks")
      .filter(
        (task) =>
          task.sessionId === session.id &&
          !terminal(task.status) &&
          (!agentId || task.agentId === agentId) &&
          (!taskId || task.id === taskId),
      );
    if (!taskId && !agentId && !this.isAdmin(session, actor) && tasks.length > 1)
      throw new Error("请使用 /stop --task <ID> 指定任务。");
    for (const task of tasks) {
      if (!this.isAdmin(session, actor) && actorKey(actor) !== actorKey(task.actor))
        throw new Error("无权停止其他成员的工作。");
      if (
        this.activeBindings.get(`${session.id}:${task.agentId}`) === task.id &&
        !(await this.resolveAdapter(task.agentId)).capabilities.cancel
      )
        throw new CancellationUnsupportedError(`Agent ${task.agentId} 不支持取消，请等待当前执行结束。`);
      const runtime = this.graphs.get(task.graphId);
      if (runtime) await runtime.cancel(randomUUID(), task.graphTaskId);
      const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${task.agentId}`);
      if (binding?.conversationId && this.activeBindings.get(binding.id) === task.id)
        await (await this.resolveAdapter(task.agentId)).cancel?.(binding.conversationId);
      await this.taskJobs.get(task.id);
      if (runtime)
        await new Promise<void>((resolve) => {
          let unsubscribe = () => {};
          const finish = () => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          };
          const check = () => {
            const current = this.store.get<GatewayTask>("tasks", task.id);
            if (!current || terminal(current.status) || current.status === "recovery-required") finish();
          };
          const timer = setTimeout(finish, this.options.settings.shutdownMs);
          unsubscribe = this.observe(check);
          check();
        });
    }
  }
  async manageSession(session: GatewaySession, actor: GatewayActor, action: string, confirmed = false): Promise<void> {
    return management.manageSession.call(this.managementOwner(), session, actor, action, confirmed);
  }
  private managementOwner(): management.GatewayManagementOwner {
    const owner = this;
    return {
      store: this.store,
      repository: this.repository,
      options: this.options,
      reconfiguring: this.reconfiguring,
      configurationJobs: this.configurationJobs,
      adapters: this.adapters,
      adapterStates: this.adapterStates,
      inputAdmissions: this.inputAdmissions,
      bindingJobs: this.bindingJobs,
      jobs: this.jobs,
      taskJobs: this.taskJobs,
      approvalWaiters: this.approvalWaiters,
      get closing() {
        return owner.closing;
      },
      get configurationWrite() {
        return owner.configurationWrite;
      },
      set configurationWrite(value) {
        owner.configurationWrite = value;
      },
      stop: this.stop.bind(this),
      session: this.session.bind(this),
      changed: this.changed.bind(this),
      record: this.record.bind(this),
      requireAdmin: this.requireAdmin.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      waitForAgentApprovals: this.waitForAgentApprovals.bind(this),
      closeAdapter: this.closeAdapter.bind(this),
    };
  }
  async maintain(): Promise<void> {
    return maintenance.maintain.call(this.maintenanceOwner());
  }
  private closeAdapter(
    id: string,
    pending: Promise<GatewayAgentAdapter>,
    bindings: GatewayBinding[] = [],
  ): Promise<void> {
    return maintenance.closeAdapter.call(this.maintenanceOwner(), id, pending, bindings);
  }
  private maintenanceOwner(): maintenance.GatewayMaintenanceOwner {
    const owner = this;
    return {
      store: this.store,
      options: this.options,
      maintenanceJobs: this.maintenanceJobs,
      adapters: this.adapters,
      adapterStates: this.adapterStates,
      adapterClosings: this.adapterClosings,
      adapterUsedAt: this.adapterUsedAt,
      reconfiguring: this.reconfiguring,
      inputAdmissions: this.inputAdmissions,
      dialogueJobs: this.dialogueJobs,
      bindingJobs: this.bindingJobs,
      approvalWaiters: this.approvalWaiters,
      get closing() {
        return owner.closing;
      },
      handle: this.handle.bind(this),
      session: this.session.bind(this),
      canAccess: this.canAccess.bind(this),
      changed: this.changed.bind(this),
      resolveAdapter: this.resolveAdapter.bind(this),
      record: this.record.bind(this),
      pluginHost: this.pluginHost.bind(this),
    };
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      const settle = async (operations: readonly Promise<unknown>[]) => {
        for (const result of await Promise.allSettled(operations))
          if (result.status === "rejected") errors.push(result.reason);
      };
      const wait = (async () => {
        await Promise.allSettled([...this.admission.values()].map((item) => item.job));
        await settle([...this.jobs.values()]);
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          wait,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.options.settings.shutdownMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await settle(
        [...this.graphs.values()].map(async (runtime) =>
          (await this.pluginHost()).get(coordinationService).release(runtime),
        ),
      );
      await Promise.allSettled([...this.admission.values()].map((item) => item.job));
      await settle(
        [...this.graphs.values()].map(async (runtime) =>
          (await this.pluginHost()).get(coordinationService).release(runtime),
        ),
      );
      await settle([...this.jobs.values()]);
      await settle([...this.relays.values()]);
      await Promise.allSettled([...this.bindingJobs.values()]);
      try {
        for (const approval of this.store.list<GatewayApproval>("approvals"))
          if (approval.status === "pending")
            this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
        this.changed();
      } catch (error) {
        errors.push(error);
      }
      await settle([...this.configurationJobs, ...this.maintenanceJobs]);
      await settle([this.configurationWrite]);
      await settle([...this.adapterClosings.values()]);
      await settle([...this.adapters].map(([id, adapter]) => this.closeAdapter(id, adapter)));
      if (this.plugins) await settle([this.plugins.then((host) => host.close())]);
      if (this.permissionStore && errors.length === 0)
        await settle([this.permissionStore.then((store) => store.close())]);
      try {
        this.store.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError([...new Set(errors)], "Gateway cleanup failed");
    })();
    this.changed();
    return this.closePromise;
  }
}
