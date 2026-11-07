import type { CoordinationSnapshot } from "@sortedyuan/coordination";
import type { AgentGateway } from "../gateway.js";
import { withGatewayConfiguration } from "../gateway-config.js";
import { gatewayEntry } from "../gateway-settings.js";
import type { GatewayStore } from "../gateway-store.js";
import type { GatewayRepository } from "../gateway-repository.js";
import {
  digest,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayAgentConfig,
  type GatewayApproval,
  type GatewayBinding,
  type GatewayEntry,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
} from "../gateway-types.js";
import type { GatewayTask } from "../gateway-types.js";
import type { GraphRecord } from "./task-projection.js";

export class CancellationUnsupportedError extends Error {}
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const unknownOutcome = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "outcome" in error && error.outcome === "unknown";

export interface GatewayManagementOwner extends Pick<AgentGateway, "stop" | "session" | "changed"> {
  readonly store: GatewayStore;
  readonly repository: GatewayRepository;
  readonly options: { configPath: string; settings: GatewaySettings };
  readonly closing: boolean;
  readonly reconfiguring: Set<string>;
  readonly configurationJobs: Set<Promise<void>>;
  configurationWrite: Promise<void>;
  readonly adapters: Map<string, Promise<GatewayAgentAdapter>>;
  readonly adapterStates: Map<string, "loading" | "loaded" | "unavailable">;
  readonly inputAdmissions: Map<string, Promise<void>>;
  readonly bindingJobs: Map<string, Promise<GatewayBinding>>;
  readonly jobs: Map<string, Promise<void>>;
  readonly taskJobs: Map<string, Promise<void>>;
  readonly approvalWaiters: Map<string, (allowed: boolean) => void>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
  requireAdmin(session: GatewaySession, actor: GatewayActor): void;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  waitForAgentApprovals(id: string): Promise<void>;
  closeAdapter(id: string, pending: Promise<GatewayAgentAdapter>, bindings?: GatewayBinding[]): Promise<void>;
}

export async function setMemberAccess(
  this: GatewayManagementOwner,
  entry: GatewayEntry,
  userId: string,
  active: boolean,
  occurredAt = Date.now(),
): Promise<void> {
  gatewayEntry(entry);
  if (entry.kind !== "group" || !userId) throw new Error("成员变更需要群聊入口和用户 ID。");
  if (!Number.isFinite(occurredAt) || occurredAt < 0) throw new Error("成员变更事件时间无效。");
  const id = digest({ account: entry.account, conversation: entry.conversation, userId });
  const prior = this.store.get<{ updatedAt: number }>("memberships", id);
  if (prior && prior.updatedAt > occurredAt) return;
  this.store.put("memberships", id, {
    id,
    account: entry.account,
    conversation: entry.conversation,
    userId,
    active,
    updatedAt: occurredAt,
  });
  if (!active) {
    const sessions = this.store
      .list<GatewaySession>("sessions")
      .filter(
        (session) =>
          session.entry?.kind === "group" &&
          session.entry.account === entry.account &&
          session.entry.conversation === entry.conversation,
      );
    for (const session of sessions) {
      for (const approval of this.store.list<GatewayApproval>("approvals"))
        if (
          approval.sessionId === session.id &&
          approval.actor.kind === "platform" &&
          approval.actor.userId === userId &&
          approval.status === "pending"
        ) {
          try {
            if (approval.kind === "tool") {
              const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${approval.agentId}`);
              if (binding?.conversationId)
                await (
                  await this.resolveAdapter(approval.agentId)
                ).resolveApproval?.(binding.conversationId, approval.requestId, "deny");
            }
            this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
          } catch (error) {
            if (!unknownOutcome(error)) throw error;
            this.store.put("approvals", approval.id, {
              ...approval,
              status: "unknown",
              decision: "deny",
              decidedBy: { kind: "operator", id: "membership" },
            });
            this.record(session, {
              kind: "notice",
              text: `成员 ${userId} 的访问权限已撤销；审批 ${approval.id} 的拒绝结果尚未确认，需要核对 Agent 状态。`,
              agentId: approval.agentId,
              ...(approval.taskId ? { taskId: approval.taskId } : {}),
            });
          }
          this.approvalWaiters.get(approval.id)?.(false);
          this.approvalWaiters.delete(approval.id);
        }
      for (const task of this.store.list<GatewayTask>("tasks"))
        if (
          task.sessionId === session.id &&
          task.actor.kind === "platform" &&
          task.actor.userId === userId &&
          !terminal(task.status)
        ) {
          let notice: string | undefined;
          try {
            await this.stop(session, { kind: "operator", id: "membership" }, undefined, task.id);
          } catch (error) {
            if (error instanceof CancellationUnsupportedError)
              notice = `成员 ${userId} 的访问权限已撤销；Agent ${task.agentId} 不支持取消，任务 ${task.id} 仍在执行。`;
            else if (unknownOutcome(error)) {
              notice = `成员 ${userId} 的访问权限已撤销；任务 ${task.id} 的取消结果尚未确认，需要核对 Agent 状态。`;
              const current = this.store.get<GatewayTask>("tasks", task.id);
              if (current && !terminal(current.status))
                this.store.put("tasks", task.id, {
                  ...current,
                  status: "recovery-required",
                  detail: notice,
                  updatedAt: Date.now(),
                });
            } else throw error;
          }
          const current = this.store.get<GatewayTask>("tasks", task.id);
          if (!notice && current?.status === "recovery-required")
            notice = `成员 ${userId} 的访问权限已撤销；任务 ${task.id} 的执行结果尚未确认，需要核对 Agent 状态。`;
          if (
            notice &&
            !this.store
              .list<GatewayMessage>("messages")
              .some(
                (message) => message.sessionId === session.id && message.taskId === task.id && message.text === notice,
              )
          )
            this.record(session, { kind: "notice", text: notice, agentId: task.agentId, taskId: task.id });
        }
    }
  }
  this.changed();
}

export async function setSessionAdmins(
  this: GatewayManagementOwner,
  id: string,
  actor: GatewayActor,
  keys: string[],
): Promise<void> {
  if (actor.kind !== "operator") throw new Error("配置会话管理员需要服务管理员权限。");
  this.session(id, actor);
  if (keys.some((key) => !key.trim())) throw new Error("管理员身份不能为空。");
  await saveConfiguration.call(this, (raw) => {
    const access = raw.access as Record<string, unknown> | undefined;
    raw.access = {
      ...access,
      sessionAdmins: { ...((access?.sessionAdmins as object) ?? {}), [id]: [...new Set(keys)] },
    };
  });
  this.options.settings.access.sessionAdmins[id] = [...new Set(keys)];
  this.changed();
}

export async function updateAgent(
  this: GatewayManagementOwner,
  id: string,
  actor: GatewayActor,
  config: GatewayAgentConfig | null,
): Promise<void> {
  if (this.closing) throw new Error("Gateway 正在关闭。");
  if (actor.kind !== "operator") throw new Error("修改 Agent 配置需要服务管理员权限。");
  if (config && config.id !== id) throw new Error("Agent ID 与配置不一致。");
  if (this.reconfiguring.has(id)) throw new Error(`Agent ${id} 已在等待配置更新。`);
  if (!config && this.store.list<GatewayBinding>("bindings").some((binding) => binding.agentId === id))
    throw new Error("Agent 仍有关联对话，请先清理对应会话。");
  this.reconfiguring.add(id);
  this.changed();
  let finishConfiguration!: () => void;
  const configurationJob = new Promise<void>((resolve) => {
    finishConfiguration = resolve;
  });
  this.configurationJobs.add(configurationJob);
  try {
    const unresolved = () =>
      this.store.list<GatewayTask>("tasks").some((task) => task.agentId === id && task.status === "recovery-required");
    if (unresolved()) throw new Error(`Agent ${id} 存在需要核对的执行结果，请处理恢复事项后修改配置。`);
    if (
      this.store
        .list<{ agentId: string; status: string }>("steering")
        .some(
          (item) => item.agentId === id && ["pending", "idle", "sending", "starting", "unknown"].includes(item.status),
        )
    )
      throw new Error(`Agent ${id} 仍有已接收的补充信息，请处理后修改配置。`);
    await Promise.all([...this.inputAdmissions.values()]);
    await this.waitForAgentApprovals(id);
    await Promise.all(
      [...this.bindingJobs]
        .filter(([key]) => this.store.get<GatewayBinding>("bindings", key)?.agentId === id)
        .map(([, job]) => job),
    );
    const graphs = this.store
      .list<CoordinationSnapshot>("coordination")
      .filter((graph) => graph.tasks.some((task) => !terminal(task.status)));
    if (graphs.some((graph) => graph.tasks.some((task) => task.status === "recovery-required")))
      throw new Error(`Agent ${id} 的协作任务需要核对，请处理恢复事项后修改配置。`);
    await Promise.all(
      graphs.flatMap((graph) => {
        const job = this.jobs.get(graph.id);
        return job === undefined ? [] : [job];
      }),
    );
    await Promise.all(
      this.store
        .list<GatewayTask>("tasks")
        .filter((task) => task.agentId === id && !terminal(task.status))
        .flatMap((task) => {
          const job = this.taskJobs.get(task.id);
          return job === undefined ? [] : [job];
        }),
    );
    const unfinished = this.store
      .list<CoordinationSnapshot>("coordination")
      .some(
        (graph) =>
          (graphs.some((prior) => prior.id === graph.id) ||
            graph.tasks.some((task) => task.agent === id && !terminal(task.status))) &&
          graph.tasks.some((task) => !terminal(task.status)),
      );
    if (
      unfinished ||
      this.store.list<GatewayTask>("tasks").some((task) => task.agentId === id && !terminal(task.status))
    )
      throw new Error(`Agent ${id} 仍有等待或需要核对的任务，请完成或停止协作任务后修改配置。`);
    if (this.closing) throw new Error("Gateway 正在关闭，尚未应用 Agent 配置。");
    await saveConfiguration.call(this, (raw) => {
      if (raw.agents !== undefined && !Array.isArray(raw.agents)) throw new Error("agents 必须为列表。");
      const currentAgents = (raw.agents ?? []) as GatewayAgentConfig[];
      raw.agents = currentAgents.filter((agent) => agent.id !== id).concat(config ? [config] : []);
    });
    const previous = this.adapters.get(id);
    if (previous) await this.closeAdapter(id, previous);
    this.adapterStates.delete(id);
    const index = this.options.settings.agents.findIndex((agent) => agent.id === id);
    if (index >= 0) this.options.settings.agents.splice(index, 1);
    if (config) this.options.settings.agents.push(config);
  } finally {
    finishConfiguration();
    this.configurationJobs.delete(configurationJob);
    this.reconfiguring.delete(id);
    this.changed();
  }
}

function saveConfiguration(
  this: GatewayManagementOwner,
  change: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const job = withGatewayConfiguration(this.options.configPath, async (raw, save) => {
    change(raw);
    const { gatewaySettings } = await import("../gateway-settings.js");
    gatewaySettings({ path: this.options.configPath, providers: {}, models: {}, apps: { maybeclaw: raw } });
    await save();
  });
  this.configurationWrite = job.then(
    () => {},
    () => {},
  );
  return job;
}

export async function manageSession(
  this: GatewayManagementOwner,
  session: GatewaySession,
  actor: GatewayActor,
  action: string,
  confirmed = false,
): Promise<void> {
  this.requireAdmin(session, actor);
  if (this.inputAdmissions.has(session.id)) throw new Error("会话正在接收输入，请等待接收完成。");
  if (
    this.store.list<GatewayTask>("tasks").some((task) => task.sessionId === session.id && !terminal(task.status)) ||
    this.store
      .list<GatewayApproval>("approvals")
      .some((approval) => approval.sessionId === session.id && approval.status === "pending")
  )
    throw new Error("会话仍有活动工作或审批，请先停止或等待完成。");
  if (action === "delete") {
    if (!confirmed) throw new Error("删除将清理会话、专用 Agent 对话和未发送消息。添加 --confirm 确认。");
    this.store.put("sessions", session.id, { ...session, status: "deleting" });
    await Promise.all(
      this.store
        .list<GraphRecord>("graphs")
        .filter((graph) => graph.sessionId === session.id)
        .flatMap((graph) => {
          const job = this.jobs.get(graph.id);
          return job === undefined ? [] : [job];
        }),
    );
    for (const binding of this.store.list<GatewayBinding>("bindings").filter((item) => item.sessionId === session.id)) {
      const adapter = await this.resolveAdapter(binding.agentId);
      if (!adapter.capabilities.delete || !adapter.deleteConversation || !binding.conversationId)
        throw new Error(`Agent ${binding.agentId} 对话清理尚未完成。`);
      await adapter.deleteConversation(binding.conversationId);
      this.store.delete("bindings", binding.id);
    }
    this.repository.deleteSession(session.id);
  } else
    this.store.put("sessions", session.id, {
      ...session,
      status: action === "restore" ? "active" : "archived",
      updatedAt: Date.now(),
    });
  this.changed();
}
