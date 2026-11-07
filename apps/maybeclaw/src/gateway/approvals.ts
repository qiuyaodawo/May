import { randomUUID } from "node:crypto";
import type { AgentApplicationEvent } from "@sortedyuan/may";
import type { ApprovalDecision, ApprovalRequest } from "@sortedyuan/may/permissions";
import type { AgentGateway } from "../gateway.js";
import type { GatewayStore } from "../gateway-store.js";
import {
  actorKey,
  digest,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayApproval,
  type GatewayBinding,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
  type GatewayTask,
} from "../gateway-types.js";

export interface GatewayApprovalOwner extends Pick<AgentGateway, "observe" | "session" | "canAccess" | "changed"> {
  readonly store: GatewayStore;
  readonly options: { settings: GatewaySettings };
  readonly closing: boolean;
  readonly approvalWaiters: Map<string, (allowed: boolean) => void>;
  requireAdmin(session: GatewaySession, actor: GatewayActor): void;
  authorizeAgent(id: string, actor: GatewayActor, entry?: GatewaySession["entry"], acceptedWork?: boolean): void;
  binding(session: GatewaySession, agentId: string): Promise<GatewayBinding>;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
}

export function waitForAgentApprovals(this: GatewayApprovalOwner, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (this.closing) {
        unsubscribe();
        reject(new Error("Gateway 正在关闭，尚未应用 Agent 配置。"));
        return;
      }
      const approvals = this.store.list<GatewayApproval>("approvals").filter((approval) => approval.agentId === id);
      if (approvals.some((approval) => approval.status === "unknown")) {
        unsubscribe();
        reject(new Error(`Agent ${id} 存在需要核对的审批结果。`));
      } else if (!approvals.some((approval) => approval.status === "pending" || approval.status === "resolving")) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = this.observe(inspect);
    inspect();
  });
}

export function requestApproval(
  this: GatewayApprovalOwner,
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
  const previous = this.store
    .list<GatewayApproval>("approvals")
    .filter(
      (item) =>
        item.sessionId === session.id && item.agentId === agentId && item.requestId === requestId && item.kind === kind,
    );
  const existing = previous.find((item) => item.status === "pending");
  if (existing) return existing;
  const id = previous.length ? randomUUID() : digest({ session: session.id, agent: agentId, requestId, kind });
  const approval: GatewayApproval = {
    id,
    sessionId: session.id,
    agentId,
    actor,
    kind,
    requestId,
    text,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + this.options.settings.approvalMs,
    ...(taskId ? { taskId } : {}),
    ...(grantKey ? { grantKey } : {}),
    ...(persistent ? { persistent } : {}),
  };
  this.store.put("approvals", id, approval);
  this.record(session, {
    kind: "notice",
    text: `${text}\n审批：/approve ${id} 或 /deny ${id}`,
    agentId,
    ...(taskId ? { taskId } : {}),
  });
  return approval;
}

export function onEvent(
  this: GatewayApprovalOwner,
  session: GatewaySession,
  task: GatewayTask,
  event: AgentApplicationEvent,
): void {
  const id = `${task.id}:${task.inputId}:${randomUUID()}`;
  this.store.put("events", id, { id, sessionId: session.id, taskId: task.id, event, at: Date.now() });
  if (event.type === "permission.event" && event.event.type === "approval.requested") {
    const request = event.event.request;
    requestApproval.call(
      this,
      session,
      task.agentId,
      task.actor,
      "tool",
      request.id,
      `工具 ${request.tool.name} 等待审批。\n参数：${JSON.stringify(request.input)}${request.persistent ? `\n持久规则范围：${request.persistent.description}` : ""}`,
      task.id,
      request.grantKey,
      request.persistent,
    );
  }
  this.changed();
}

export async function resolveApproval(
  this: GatewayApprovalOwner,
  id: string,
  actor: GatewayActor,
  decision: ApprovalDecision,
): Promise<void> {
  if (!["allow", "allow-session", "allow-persistent", "deny"].includes(decision)) throw new TypeError("审批决定无效。");
  const approval = this.store.get<GatewayApproval>("approvals", id);
  if (!approval) throw new Error("审批请求不存在。");
  const session = this.session(approval.sessionId, actor);
  this.requireAdmin(session, actor);
  if (approval.status !== "pending" || approval.expiresAt <= Date.now()) throw new Error("审批已经处理或已经过期。");
  if (decision === "allow-session" && (approval.kind !== "tool" || !approval.grantKey))
    throw new Error("此请求不支持持续授权。");
  if (
    decision === "allow-persistent" &&
    (actor.kind !== "operator" ||
      !this.options.settings.persistentRules ||
      approval.kind !== "tool" ||
      !approval.persistent)
  )
    throw new Error("保存持久权限规则需要服务管理员权限，以及已启用的持久规则范围。");
  if (!this.canAccess(session, approval.actor)) throw new Error("请求发起者的访问权限已失效。");
  this.authorizeAgent(approval.agentId, approval.actor, session.entry, true);
  this.store.put("approvals", id, { ...approval, status: "resolving", decision, decidedBy: actor });
  try {
    if (approval.kind === "create-agent") {
      const waiter = this.approvalWaiters.get(id);
      if (waiter) {
        this.approvalWaiters.delete(id);
        waiter(decision !== "deny");
      } else if (decision !== "deny") await this.binding(session, approval.agentId);
    } else {
      const binding = this.store.get<GatewayBinding>("bindings", `${session.id}:${approval.agentId}`),
        adapter = await this.resolveAdapter(approval.agentId);
      if (
        !binding?.conversationId ||
        !adapter.resolveApproval ||
        !(await adapter.resolveApproval(
          binding.conversationId,
          approval.requestId,
          decision,
          decision === "allow-persistent" ? { createdBy: actorKey(actor) } : undefined,
        ))
      )
        throw new Error("Agent 已不再等待此审批。");
    }
    this.store.put("approvals", id, {
      ...approval,
      status: decision === "deny" ? "denied" : "allowed",
      decision,
      decidedBy: actor,
    });
  } catch (error) {
    this.store.put("approvals", id, { ...approval, status: "unknown", decision, decidedBy: actor });
    this.changed();
    throw error;
  }
  this.changed();
}

export function cancelApprovals(this: GatewayApprovalOwner, taskId: string): void {
  for (const approval of this.store.list<GatewayApproval>("approvals"))
    if (approval.taskId === taskId && approval.status === "pending")
      this.store.put("approvals", approval.id, { ...approval, status: "cancelled" });
}
