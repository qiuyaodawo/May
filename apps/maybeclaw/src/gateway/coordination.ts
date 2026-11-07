import {
  coordinationInput,
  createCoordinationTools,
  type CoordinationAgent,
  type CoordinationRuntime,
  type CoordinationSnapshot,
  type CoordinationStore,
} from "@sortedyuan/coordination";
import { coordinationService } from "@sortedyuan/coordination/plugin";
import { omitUndefined, type ContentPart, type Tool } from "@sortedyuan/may/core";
import type { AgentApplicationEvent } from "@sortedyuan/may";
import type { PluginHost } from "@sortedyuan/may/plugin";
import type { AgentGateway } from "../gateway.js";
import type { GatewayStore } from "../gateway-store.js";
import {
  actorKey,
  digest,
  entryKey,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayApproval,
  type GatewayBinding,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
  type GatewayTask,
} from "../gateway-types.js";
import type { GraphRecord } from "./task-projection.js";

export interface GatewayCoordinationOwner extends Pick<AgentGateway, "session" | "canAccess" | "changed"> {
  readonly store: GatewayStore;
  readonly options: { settings: GatewaySettings };
  readonly reconfiguring: Set<string>;
  readonly graphs: Map<string, CoordinationRuntime>;
  readonly jobs: Map<string, Promise<void>>;
  readonly relays: Map<string, Promise<void>>;
  readonly taskJobs: Map<string, Promise<void>>;
  readonly dialogueJobs: Map<string, Promise<void>>;
  readonly activeBindings: Map<string, string>;
  readonly slotWaiters: Array<() => void>;
  readonly approvalWaiters: Map<string, (allowed: boolean) => void>;
  runningCount: number;
  error: string | undefined;
  authorizeAgent(id: string, actor: GatewayActor, entry?: GatewaySession["entry"], acceptedWork?: boolean): void;
  requestApproval(
    session: GatewaySession,
    agentId: string,
    actor: GatewayActor,
    kind: GatewayApproval["kind"],
    requestId: string,
    text: string,
    taskId?: string,
  ): GatewayApproval;
  cancelApprovals(taskId: string): void;
  binding(session: GatewaySession, agentId: string): Promise<GatewayBinding>;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
  pluginHost(): Promise<PluginHost>;
  onEvent(session: GatewaySession, task: GatewayTask, event: AgentApplicationEvent): void;
  projectTask(graph: GraphRecord, source: CoordinationSnapshot["tasks"][number]): GatewayTask;
  completeTask(task: GatewayTask, result: { text: string; runId?: string; content?: ContentPart[] }): GatewayTask;
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const safeError = (error: unknown): string => (error instanceof Error ? error.message : "Gateway 操作失败。");

export function coordinationStore(this: GatewayCoordinationOwner): CoordinationStore {
  return {
    acquire: async (id) => ({
      read: async () => this.store.get<CoordinationSnapshot>("coordination", id),
      commit: async (snapshot, revision) => {
        this.store.transaction(() => {
          const prior = this.store.get<CoordinationSnapshot>("coordination", id);
          if ((prior?.revision ?? 0) !== revision) throw new Error("协作记录版本冲突。");
          this.store.put("coordination", id, snapshot);
        });
      },
      close: async () => {},
    }),
  };
}

export function policy(this: GatewayCoordinationOwner, session: GatewaySession, actor: GatewayActor) {
  const versions = new Map(this.options.settings.agents.map((agent) => [agent.id, digest(agent)]));
  const accepted = new Set(
    this.options.settings.agents.filter((agent) => !this.reconfiguring.has(agent.id)).map((agent) => agent.id),
  );
  const authorized = (agent: string) => {
    const current = this.store.get<GatewaySession>("sessions", session.id),
      config = this.options.settings.agents.find((item) => item.id === agent);
    if (
      !current ||
      !this.canAccess(current, actor) ||
      current.status !== "active" ||
      !config ||
      versions.get(agent) !== digest(config)
    )
      return false;
    this.authorizeAgent(agent, actor, current.entry, accepted.has(agent));
    return true;
  };
  return {
    version: digest(this.options.settings.access),
    authorize: (task: { agent: string }) => authorized(task.agent),
    authorizeDelegation: (_parent: unknown, child: { agent: string }) => authorized(child.agent),
    authorizeMessage: (sender: { agent: string }, recipient: { agent: string }) =>
      authorized(sender.agent) && authorized(recipient.agent),
    authorizeHandoff: (_source: unknown, target: { agent: string }) => authorized(target.agent),
  };
}

export function coordinationAgents(
  this: GatewayCoordinationOwner,
  session: GatewaySession,
  actor: GatewayActor,
  graphId: string,
): Record<string, CoordinationAgent> {
  return Object.fromEntries(
    this.options.settings.agents.map((config) => [
      config.id,
      {
        version: digest(config),
        execute: async (execution, context) => {
          const graphRecord = this.store.get<GraphRecord>("graphs", graphId);
          const taskId = `${graphId}:${execution.task.id}`,
            inputId =
              graphRecord?.rootInputId && !execution.task.parentTaskId && (execution.task.turn ?? 0) === 0
                ? graphRecord.rootInputId
                : `${execution.task.dispatchId}:${execution.task.turn ?? 0}`;
          const task: GatewayTask = {
            id: taskId,
            sessionId: session.id,
            agentId: config.id,
            graphId,
            graphTaskId: execution.task.id,
            actor,
            input: execution.task.input,
            inputId,
            status: "queued",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.store.put("tasks", taskId, task);
          this.changed();
          let failureReported = false;
          let finishTask!: () => void;
          const taskJob = new Promise<void>((resolve) => {
            finishTask = resolve;
          });
          this.taskJobs.set(taskId, taskJob);
          try {
            const current = this.session(session.id, actor);
            const existing = this.store.get<GatewayBinding>("bindings", `${session.id}:${config.id}`);
            if (!existing && !current.allowedAgents.includes(config.id)) {
              const approval = this.requestApproval(
                current,
                config.id,
                actor,
                "create-agent",
                inputId,
                `创建 ${config.id} 对话`,
                taskId,
              );
              this.store.put("tasks", taskId, { ...task, status: "waiting" });
              const allowed = await new Promise<boolean>((resolve) => {
                this.approvalWaiters.set(approval.id, resolve);
                const abort = () => {
                  this.approvalWaiters.delete(approval.id);
                  resolve(false);
                };
                context.signal.addEventListener("abort", abort, { once: true });
                if (context.signal.aborted) abort();
              });
              if (!allowed) {
                this.cancelApprovals(taskId);
                finishTask();
                this.taskJobs.delete(taskId);
                this.store.put("tasks", taskId, {
                  ...task,
                  status: context.signal.aborted ? "cancelled" : "failed",
                  detail: "创建 Agent 对话的审批未通过。",
                });
                throw new Error("创建 Agent 对话的审批未通过。");
              }
            }
            context.signal.throwIfAborted();
            const binding = await this.binding(current, config.id),
              adapter = await this.resolveAdapter(config.id);
            const key = binding.id,
              previous = this.dialogueJobs.get(key) ?? Promise.resolve();
            let release!: () => void;
            const own = new Promise<void>((resolve) => {
              release = resolve;
            });
            const chain = previous.then(() => own);
            this.dialogueJobs.set(key, chain);
            await previous;
            let yielded = false,
              slot = false;
            try {
              await acquireSlot.call(this, context.signal);
              slot = true;
              context.signal.throwIfAborted();
              this.activeBindings.set(key, taskId);
              this.store.put("tasks", taskId, { ...task, status: "running" });
              this.changed();
              const taskInput = coordinationInput(execution),
                graph = this.store.get<GraphRecord>("graphs", graphId);
              if (!execution.task.parentTaskId && (execution.task.turn ?? 0) === 0 && graph?.content)
                taskInput.content.push(...graph.content);
              const tools: Tool[] = adapter.capabilities.collaboration
                ? [
                    ...createCoordinationTools(context, () => {
                      yielded = true;
                    }),
                    {
                      name: "list_agents",
                      description:
                        "List registered Agents available to this session before choosing a delegation or handoff target. Shows whether creating its conversation requires approval.",
                      inputSchema: { type: "object", properties: {}, additionalProperties: false },
                      execute: async () => {
                        const visible = this.session(session.id, actor);
                        const scope = visible.entry ? entryKey(visible.entry) : actorKey(actor);
                        const allowed =
                          this.options.settings.access.allowedAgents[scope] ??
                          this.options.settings.access.allowedAgents[actorKey(actor)];
                        return this.options.settings.agents
                          .filter((agent) => agent.enabled !== false && (!allowed || allowed.includes(agent.id)))
                          .map((agent) => ({
                            id: agent.id,
                            name: agent.name ?? agent.id,
                            requiresCreationApproval:
                              !visible.allowedAgents.includes(agent.id) &&
                              !this.store.get<GatewayBinding>("bindings", `${visible.id}:${agent.id}`)?.conversationId,
                          }));
                      },
                    },
                  ]
                : [];
              const result = await adapter.execute({
                conversationId: binding.conversationId!,
                inputId,
                input: taskInput,
                signal: context.signal,
                ...omitUndefined({ telemetry: execution.telemetry }),
                permissionScope: JSON.stringify(
                  actor.kind === "operator" ? ["operator", actor.id] : ["platform", actor.account, actor.userId],
                ),
                tools,
                shouldYield: () => yielded,
                report: (event) => {
                  context.report(event);
                  this.onEvent(session, task, event);
                },
              });
              this.store.transaction(() => {
                this.store.put("bindings", binding.id, { ...binding, usedAt: Date.now() });
                if (result.yielded)
                  this.store.put("tasks", taskId, {
                    ...task,
                    status: "waiting",
                    result: result.text,
                    ...(result.runId ? { runId: result.runId } : {}),
                    updatedAt: Date.now(),
                  });
                else this.completeTask(task, result);
              });
              if (result.yielded) return { yielded: true as const };
              return { text: result.text, ...(result.runId ? { runId: result.runId } : {}) };
            } catch (error) {
              const unknown =
                typeof error === "object" && error !== null && "outcome" in error && error.outcome === "unknown";
              this.store.put("tasks", taskId, {
                ...task,
                status: unknown ? "recovery-required" : context.signal.aborted ? "cancelling" : "failed",
                detail: safeError(error),
                updatedAt: Date.now(),
              });
              this.record(current, {
                kind: "notice",
                text: unknown
                  ? safeError(error)
                  : context.signal.aborted
                    ? "已请求取消，正在核对执行状态。"
                    : safeError(error),
                agentId: config.id,
                taskId,
              });
              failureReported = true;
              throw error;
            } finally {
              if (this.activeBindings.get(key) === taskId) this.activeBindings.delete(key);
              if (slot) {
                this.runningCount--;
                this.slotWaiters.shift()?.();
              }
              release();
              if (this.dialogueJobs.get(key) === chain) this.dialogueJobs.delete(key);
            }
          } catch (error) {
            if (!failureReported) {
              const current = this.store.get<GatewaySession>("sessions", session.id);
              const detail = context.signal.aborted
                ? "执行已取消。"
                : `${safeError(error)}\n使用 /agent list 查询，或使用 /agent create <Agent> 尝试创建其他 Agent 对话。`;
              this.store.put("tasks", taskId, {
                ...task,
                status: context.signal.aborted ? "cancelled" : "failed",
                detail,
                updatedAt: Date.now(),
              });
              if (current) this.record(current, { kind: "notice", text: detail, agentId: config.id, taskId });
            }
            throw error;
          } finally {
            finishTask();
            this.taskJobs.delete(taskId);
            this.cancelApprovals(taskId);
            this.changed();
          }
        },
        recover: async (execution) => {
          const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${config.id}`);
          if (!binding?.conversationId) return { status: "not-started" as const };
          const graphRecord = this.store.get<GraphRecord>("graphs", graphId);
          const inputId =
            graphRecord?.rootInputId && !execution.task.parentTaskId && (execution.task.turn ?? 0) === 0
              ? graphRecord.rootInputId
              : `${execution.task.dispatchId}:${execution.task.turn ?? 0}`;
          const result = await (await this.resolveAdapter(config.id)).inspect(binding.conversationId, inputId);
          if (result.status === "completed") {
            if (!graphRecord) throw new Error("任务的协作记录不存在。");
            this.completeTask(this.projectTask(graphRecord, execution.task), { ...result, text: result.text ?? "" });
            return {
              status: "completed" as const,
              output: { text: result.text ?? "", ...(result.runId ? { runId: result.runId } : {}) },
            };
          }
          if (result.status === "not-started") return { status: "not-started" as const };
          if (result.status === "waiting") return { status: "yielded" as const };
          if (result.status === "failed" || result.status === "cancelled")
            return { status: result.status, detail: result.detail ?? result.status };
          return { status: "recovery-required" as const, detail: result.detail ?? "执行结果需要核对。" };
        },
      } satisfies CoordinationAgent,
    ]),
  );
}

export function launch(this: GatewayCoordinationOwner, runtime: CoordinationRuntime, id: string): void {
  this.graphs.set(id, runtime);
  const relay = (async () => {
    for await (const event of runtime.events)
      if (event.type === "state.changed") {
        for (const task of event.snapshot.tasks) {
          const key = `${id}:${task.id}`,
            current = this.store.get<GatewayTask>("tasks", key);
          if (current)
            this.store.put("tasks", key, {
              ...current,
              status: task.status,
              ...(task.detail ? { detail: task.detail } : {}),
              updatedAt: Date.now(),
            });
        }
        this.changed();
      }
  })();
  this.relays.set(id, relay);
  void relay
    .finally(() => this.relays.delete(id))
    .catch((error) => {
      this.error = safeError(error);
    });
  let closed = false;
  const job = runtime
    .wait()
    .then(async (snapshot) => {
      if (
        snapshot.tasks.every((task) => terminal(task.status)) ||
        snapshot.tasks.some((task) => task.status === "recovery-required")
      ) {
        await (await this.pluginHost()).get(coordinationService).release(runtime);
        await relay;
        closed = true;
      }
    })
    .catch((error) => {
      this.error = safeError(error);
      this.changed();
    })
    .finally(() => {
      if (closed) this.graphs.delete(id);
      this.jobs.delete(id);
    });
  this.jobs.set(id, job);
}

async function acquireSlot(this: GatewayCoordinationOwner, signal: AbortSignal): Promise<void> {
  while (this.runningCount >= this.options.settings.maxConcurrent) {
    await new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.slotWaiters.indexOf(resolve);
          if (index >= 0) this.slotWaiters.splice(index, 1);
          resolve();
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  this.runningCount++;
}
