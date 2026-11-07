import { agentAdapterRegistryService } from "@sortedyuan/gateway/adapters";
import type { PluginHost } from "@sortedyuan/may/plugin";
import type { AgentGateway } from "../gateway.js";
import type { GatewayStore } from "../gateway-store.js";
import type {
  GatewayActor,
  GatewayAgentAdapter,
  GatewayApproval,
  GatewayBinding,
  GatewayMessage,
  GatewaySession,
  GatewaySettings,
  GatewayTask,
} from "../gateway-types.js";

export interface GatewayMaintenanceOwner extends Pick<AgentGateway, "handle" | "session" | "canAccess" | "changed"> {
  readonly store: GatewayStore;
  readonly options: { settings: GatewaySettings };
  readonly closing: boolean;
  readonly maintenanceJobs: Set<Promise<void>>;
  readonly adapters: Map<string, Promise<GatewayAgentAdapter>>;
  readonly adapterStates: Map<string, "loading" | "loaded" | "unavailable">;
  readonly adapterClosings: Map<string, Promise<void>>;
  readonly adapterUsedAt: Map<string, number>;
  readonly reconfiguring: Set<string>;
  readonly inputAdmissions: Map<string, Promise<void>>;
  readonly dialogueJobs: Map<string, Promise<void>>;
  readonly bindingJobs: Map<string, Promise<GatewayBinding>>;
  readonly approvalWaiters: Map<string, (allowed: boolean) => void>;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
  pluginHost(): Promise<PluginHost>;
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
const safeError = (error: unknown): string => (error instanceof Error ? error.message : "Gateway 操作失败。");

export async function maintain(this: GatewayMaintenanceOwner): Promise<void> {
  if (this.closing) return;
  let finishMaintenance!: () => void;
  const maintenanceJob = new Promise<void>((resolve) => {
    finishMaintenance = resolve;
  });
  this.maintenanceJobs.add(maintenanceJob);
  try {
    for (const item of this.store.list<{
      id: string;
      sessionId: string;
      agentId: string;
      actor: GatewayActor;
      text: string;
      status: string;
    }>("steering")) {
      if (!["pending", "idle", "sending", "starting"].includes(item.status)) continue;
      const session = this.store.get<GatewaySession>("sessions", item.sessionId);
      if (!session || !this.canAccess(session, item.actor) || session.status !== "active") {
        this.store.put("steering", item.id, { ...item, status: "cancelled" });
        continue;
      }
      const binding = this.store.get<GatewayBinding>("bindings", `${item.sessionId}:${item.agentId}`);
      if (!binding?.conversationId || this.dialogueJobs.has(binding.id)) continue;
      const adapter = await this.resolveAdapter(item.agentId),
        state = (await adapter.steeringInputs?.(binding.conversationId))?.find((input) => input.inputId === item.id);
      if (!state) continue;
      if (state.status === "idle") {
        this.store.put("steering", item.id, { ...item, status: "starting" });
        try {
          await this.handle(`@${item.agentId} -- ${item.text}`, item.actor, {
            requestId: `steering:${item.id}`,
            sessionId: item.sessionId,
            steeringInputId: item.id,
          });
        } catch (error) {
          this.store.put("steering", item.id, { ...item, status: "unknown", detail: safeError(error) });
          this.record(this.session(item.sessionId, item.actor), {
            kind: "notice",
            agentId: item.agentId,
            text: `补充信息需要核对：${safeError(error)}`,
          });
          continue;
        }
        this.store.put("steering", item.id, { ...item, status: "delivered" });
      } else if (state.status === "delivered" || state.status === "cancelled") {
        this.store.put("steering", item.id, { ...item, status: state.status });
        if (state.status === "cancelled")
          this.record(this.session(item.sessionId, item.actor), {
            kind: "notice",
            agentId: item.agentId,
            text: `补充信息未交付：${item.text}`,
          });
      }
    }
    for (const approval of this.store.list<GatewayApproval>("approvals"))
      if (approval.status === "pending" && approval.expiresAt <= Date.now()) {
        if (approval.kind === "tool") {
          const binding = this.store.get<GatewayBinding>("bindings", `${approval.sessionId}:${approval.agentId}`);
          if (binding?.conversationId)
            await (
              await this.resolveAdapter(approval.agentId)
            ).resolveApproval?.(binding.conversationId, approval.requestId, "deny");
        }
        this.store.put("approvals", approval.id, { ...approval, status: "expired" });
        this.approvalWaiters.get(approval.id)?.(false);
        this.approvalWaiters.delete(approval.id);
        this.changed();
      }
    for (const [id, pending] of this.adapters) {
      if (this.closing || this.reconfiguring.has(id) || this.adapterClosings.has(id) || this.inputAdmissions.size)
        continue;
      const adapter = await pending;
      if (!adapter.capabilities.resume) continue;
      const bindings = this.store.list<GatewayBinding>("bindings").filter((binding) => binding.agentId === id);
      const busy = () =>
        this.inputAdmissions.size > 0 ||
        this.store.list<GatewayTask>("tasks").some((task) => task.agentId === id && !terminal(task.status)) ||
        this.store
          .list<GatewayApproval>("approvals")
          .some(
            (approval) => approval.agentId === id && ["pending", "resolving", "unknown"].includes(approval.status),
          ) ||
        this.store
          .list<{ agentId: string; status: string }>("steering")
          .some(
            (item) =>
              item.agentId === id && ["pending", "idle", "sending", "starting", "unknown"].includes(item.status),
          ) ||
        bindings.some(
          (binding) =>
            binding.status !== "ready" ||
            !binding.conversationId ||
            this.bindingJobs.has(binding.id) ||
            this.dialogueJobs.has(binding.id),
        );
      if (busy()) continue;
      const config = this.options.settings.agents.find((agent) => agent.id === id),
        idleMs = config?.idleMs ?? this.options.settings.idleMs;
      const idle = bindings.filter((binding) => Date.now() - binding.usedAt >= idleMs);
      if (idle.length === bindings.length && Date.now() - (this.adapterUsedAt.get(id) ?? Date.now()) >= idleMs) {
        await closeAdapter.call(this, id, pending, idle);
      } else
        for (const binding of idle) {
          if (busy()) break;
          await adapter.release?.(binding.conversationId!);
        }
    }
  } finally {
    finishMaintenance();
    this.maintenanceJobs.delete(maintenanceJob);
  }
}

export function closeAdapter(
  this: GatewayMaintenanceOwner,
  id: string,
  pending: Promise<GatewayAgentAdapter>,
  bindings: GatewayBinding[] = [],
): Promise<void> {
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
  void close
    .finally(() => {
      if (this.adapterClosings.get(id) === close) this.adapterClosings.delete(id);
      this.changed();
    })
    .catch(() => undefined);
  return close;
}
