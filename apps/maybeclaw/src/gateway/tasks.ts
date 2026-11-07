import {
  validateCoordinationSnapshot,
  type CoordinationAgent,
  type CoordinationPolicy,
  type CoordinationRuntime,
  type CoordinationSnapshot,
  type CoordinationStore,
} from "@sortedyuan/coordination";
import { coordinationService } from "@sortedyuan/coordination/plugin";
import type { PluginHost } from "@sortedyuan/may/plugin";
import type { ContentPart } from "@sortedyuan/may/core";
import type { AgentGateway } from "../gateway.js";
import type { GatewayRepository } from "../gateway-repository.js";
import type { GatewayStore } from "../gateway-store.js";
import {
  digest,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayBinding,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
  type GatewayTask,
} from "../gateway-types.js";
import { completeTask, projectTask, type GraphRecord } from "./task-projection.js";

export interface GatewayTaskOwner extends Pick<AgentGateway, "session" | "canAccess" | "changed"> {
  readonly store: GatewayStore;
  readonly repository: GatewayRepository;
  readonly options: { settings: GatewaySettings };
  readonly graphs: Map<string, CoordinationRuntime>;
  requireAdmin(session: GatewaySession, actor: GatewayActor): void;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
  pluginHost(): Promise<PluginHost>;
  coordinationStore(): CoordinationStore;
  coordinationAgents(session: GatewaySession, actor: GatewayActor, graphId: string): Record<string, CoordinationAgent>;
  policy(session: GatewaySession, actor: GatewayActor): CoordinationPolicy;
  launch(runtime: CoordinationRuntime, id: string): void;
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);

export async function recoverTask(this: GatewayTaskOwner, taskId: string, actor: GatewayActor): Promise<GatewayTask> {
  const task = this.store.get<GatewayTask>("tasks", taskId);
  if (!task) throw new Error("任务不存在。");
  const session = this.session(task.sessionId, actor);
  this.requireAdmin(session, actor);
  const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${task.agentId}`);
  if (!binding?.conversationId) throw new Error("Agent 对话尚未确认。");
  const outcome = await (await this.resolveAdapter(task.agentId)).inspect(binding.conversationId, task.inputId);
  if (outcome.status === "not-started") return task;
  if (outcome.status === "completed") return finishTask.call(this, task, { ...outcome, text: outcome.text ?? "" });
  const updated: GatewayTask = {
    ...task,
    status: outcome.status,
    ...(outcome.text ? { result: outcome.text } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    updatedAt: Date.now(),
  };
  this.store.put("tasks", taskId, updated);
  this.changed();
  return updated;
}

export function retryDelivery(this: GatewayTaskOwner, id: string, actor: GatewayActor, confirmUnknown = false) {
  if (actor.kind !== "operator") throw new Error("重新发送消息需要服务管理员权限。");
  const pending = this.repository.retryDelivery(id, confirmUnknown);
  this.changed();
  return pending;
}

export async function dispatchTask(this: GatewayTaskOwner, taskId: string, actor: GatewayActor): Promise<GatewayTask> {
  const task = this.store.get<GatewayTask>("tasks", taskId);
  if (!task) throw new Error("任务不存在。");
  const session = this.session(task.sessionId, actor);
  this.requireAdmin(session, actor);
  if (terminal(task.status)) return task;
  if (this.graphs.has(task.graphId)) {
    await this.graphs.get(task.graphId)!.start();
    return this.store.get<GatewayTask>("tasks", taskId)!;
  }
  const graph = this.store.get<GraphRecord>("graphs", task.graphId);
  if (!graph) throw new Error("任务的协作记录不存在。");
  const runtime = await (await this.pluginHost()).get(coordinationService).resume({
    id: graph.id,
    store: this.coordinationStore(),
    agents: this.coordinationAgents(session, graph.actor, graph.id),
    policy: this.policy(session, graph.actor),
  });
  this.launch(runtime, graph.id);
  return this.store.get<GatewayTask>("tasks", taskId)!;
}

export async function restore(this: GatewayTaskOwner): Promise<void> {
  for (const graph of this.store.list<GraphRecord>("graphs")) {
    const state = this.store.get<CoordinationSnapshot>("coordination", graph.id);
    if (!state) continue;
    validateCoordinationSnapshot(state, graph.id);
    const session = this.store.get<GatewaySession>("sessions", graph.sessionId);
    if (!session) throw new Error(`任务所属会话 ${graph.sessionId} 不存在。`);
    for (const source of state.tasks)
      if (terminal(source.status)) {
        const task = projectTask(this.store, graph, source);
        if (source.status === "completed") {
          if (!source.output) throw new Error(`已完成任务 ${task.id} 缺少结果记录。`);
          finishTask.call(this, task, source.output);
        } else
          this.store.put("tasks", task.id, {
            ...task,
            status: source.status,
            ...(source.detail ? { detail: source.detail } : {}),
            updatedAt: Date.now(),
          });
      }
    if (state.tasks.every((task) => terminal(task.status))) continue;
    let reason: string | undefined;
    if (!this.canAccess(session, graph.actor)) reason = "发起者的会话访问权限已经撤销，请服务管理员核对原工作。";
    else if (session.status !== "active") reason = "会话当前不可执行，请服务管理员核对恢复状态。";
    else if (state.policyVersion !== digest(this.options.settings.access))
      reason = "访问配置版本已经变化，请服务管理员核对原工作的授权范围。";
    else {
      const versions = new Map(this.options.settings.agents.map((agent) => [agent.id, digest(agent)]));
      const sources = [
        ...state.tasks,
        ...(state.graphChanges ?? []).flatMap((change) => change.previous),
        ...state.tasks.flatMap((task) => (task.attempts ?? []).map((attempt) => attempt.task)),
      ];
      for (const source of sources) {
        const owners = [
          source,
          ...(source.pendingHandoff ? [source.pendingHandoff] : []),
          ...(source.handoffs ?? []).flatMap((handoff) => [handoff.from, handoff.to]),
        ];
        const changed = owners.find((owner) => versions.get(owner.agent) !== owner.agentVersion);
        if (changed) {
          reason = `Agent ${changed.agent} 不存在或配置版本已经变化，请服务管理员核对原工作。`;
          break;
        }
      }
    }
    if (reason) {
      this.store.transaction(() => {
        for (const source of state.tasks)
          if (!terminal(source.status)) {
            const task = projectTask(this.store, graph, source);
            this.store.put("tasks", task.id, {
              ...task,
              status: "recovery-required",
              detail: reason,
              updatedAt: Date.now(),
            });
          }
      });
      this.changed();
      continue;
    }
    const runtime = await (await this.pluginHost()).get(coordinationService).resume({
      id: graph.id,
      store: this.coordinationStore(),
      agents: this.coordinationAgents(session, graph.actor, graph.id),
      policy: this.policy(session, graph.actor),
    });
    this.launch(runtime, graph.id);
  }
}

export function finishTask(
  this: Pick<GatewayTaskOwner, "store" | "record">,
  task: GatewayTask,
  result: { text: string; runId?: string; content?: ContentPart[] },
): GatewayTask {
  return completeTask(this.store, task, result, (session, data) => this.record(session, data));
}
