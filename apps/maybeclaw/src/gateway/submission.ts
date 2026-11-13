import { coordinationService } from "@sortedyuan/coordination/plugin";
import type { GatewayInput, GatewayReceipt } from "../gateway.js";
import {
  actorKey,
  digest,
  entryKey,
  type GatewayActor,
  type GatewayBinding,
  type GatewayMessage,
  type GatewaySession,
  type GatewayTask,
} from "../gateway-types.js";
import type { GatewayInputOwner } from "./input.js";
import type { GraphRecord } from "./task-projection.js";

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);

export async function submitInput(
  this: GatewayInputOwner,
  session: GatewaySession,
  actor: GatewayActor,
  input: GatewayInput,
  { agentId, body, steer }: { agentId: string | undefined; body: string; steer: boolean },
): Promise<GatewayReceipt> {
  const previousAdmission = this.inputAdmissions.get(session.id) ?? Promise.resolve();
  let releaseAdmission!: () => void;
  const ownAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const admissionChain = previousAdmission.then(() => ownAdmission);
  this.inputAdmissions.set(session.id, admissionChain);
  await previousAdmission;
  try {
    const agents = agentId ? [agentId] : session.defaultAgents;
    for (const id of agents) this.authorizeAgent(id, actor, session.entry);
    await Promise.all(agents.map((id) => this.resolveAdapter(id)));
    if (this.closing) throw new Error("Gateway 正在关闭。");
    if (this.session(session.id, actor).status !== "active") throw new Error("会话当前不可接收输入。");
    if (steer && agents.length !== 1) throw new Error("请使用 @Agent 明确补充信息的目标。");
    const active = this.store
      .list<GatewayTask>("tasks")
      .filter((task) => task.sessionId === session.id && agents.includes(task.agentId) && !terminal(task.status));
    for (const task of active)
      if (!this.isAdmin(session, actor) && actorKey(task.actor) !== actorKey(actor))
        throw new Error("目标 Agent 正在处理其他成员的工作。");
    if (steer && active.length) {
      const id = agents[0]!,
        adapter = await this.resolveAdapter(id),
        binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${id}`);
      if (binding?.status !== "ready" || !binding.conversationId)
        throw new Error("Agent 对话尚未就绪，请等待创建或审批完成。");
      if (!adapter.capabilities.steer || !adapter.steer) throw new Error("此 Agent 不支持 /steer。");
      const steeringId = digest({
        actor: actorKey(actor),
        requestId: input.requestId,
        session: session.id,
        agent: id,
      });
      const message = this.record(session, { kind: "user", text: body, actor, agentId: id }, actor.kind === "operator");
      const intent = {
        id: steeringId,
        sessionId: session.id,
        agentId: id,
        actor,
        text: body,
        messageId: message.id,
        status: "sending",
      };
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
    if (
      this.store
        .list<GatewayTask>("tasks")
        .some((task) => task.sessionId === session.id && agents.includes(task.agentId) && !terminal(task.status))
    )
      throw new Error("原执行尚未确认结束，请查询 /status 后处理恢复事项。");
    const steering = input.steeringInputId
      ? this.store.get<{ messageId: string }>("steering", input.steeringInputId)
      : undefined;
    const priorSteer = steering ? this.store.get<GatewayMessage>("messages", steering.messageId) : undefined;
    const message =
      priorSteer ??
      this.record(
        session,
        {
          kind: "user",
          text: body,
          actor,
          ...(input.content ? { content: input.content } : {}),
          ...(input.messageId ? { sourceMessageId: input.messageId } : {}),
          ...(input.entry ? { sourceEntry: entryKey(input.entry) } : {}),
        },
        actor.kind === "operator",
      );
    if (input.entry && input.messageId)
      this.repository.registerPlatformMessage(input.entry, input.messageId, { sessionId: session.id });
    const graphId = digest({ requestId: input.requestId, actor: actorKey(actor) });
    this.store.put("graphs", graphId, {
      id: graphId,
      sessionId: session.id,
      actor,
      messageId: message.id,
      ...(input.content ? { content: input.content } : {}),
      ...(input.steeringInputId ? { rootInputId: input.steeringInputId } : {}),
    } satisfies GraphRecord);
    if (this.closing) throw new Error("Gateway 正在关闭。");
    const runtime = await (await this.pluginHost()).get(coordinationService).create({
      id: graphId,
      store: this.coordinationStore(),
      agents: this.coordinationAgents(session, actor, graphId),
      policy: this.policy(session, actor),
      tasks: agents.map((id, index) => ({ id: `request-${index}`, agent: id, input: body })),
      limits: {
        maxConcurrent: this.options.settings.maxConcurrent,
        maxTasks: 64,
        maxTaskTurns: 32,
        maxDurationMs: 3_600_000,
      },
    });
    this.launch(runtime, graphId);
    await runtime.start();
    return {
      text: `已接受输入：${session.name}\nAgent：${agents.join(", ")}`,
      sessionId: session.id,
      taskIds: agents.map((_, index) => `${graphId}:request-${index}`),
    };
  } finally {
    releaseAdmission();
    if (this.inputAdmissions.get(session.id) === admissionChain) this.inputAdmissions.delete(session.id);
  }
}
