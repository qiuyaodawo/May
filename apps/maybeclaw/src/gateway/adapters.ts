import { randomUUID } from "node:crypto";
import { agentAdapterRegistryService } from "@sortedyuan/gateway/adapters";
import type { PluginHost } from "@sortedyuan/may/plugin";
import type { GatewayStore } from "../gateway-store.js";
import {
  digest,
  type GatewayAgentAdapter,
  type GatewayBinding,
  type GatewaySession,
  type GatewaySettings,
} from "../gateway-types.js";

export interface GatewayAdapterOwner {
  readonly store: GatewayStore;
  readonly options: { settings: GatewaySettings };
  readonly adapters: Map<string, Promise<GatewayAgentAdapter>>;
  readonly adapterStates: Map<string, "loading" | "loaded" | "unavailable">;
  readonly adapterClosings: Map<string, Promise<void>>;
  readonly adapterUsedAt: Map<string, number>;
  readonly bindingJobs: Map<string, Promise<GatewayBinding>>;
  pluginHost(): Promise<PluginHost>;
  changed(): void;
}

export async function resolveAdapter(this: GatewayAdapterOwner, id: string): Promise<GatewayAgentAdapter> {
  await this.adapterClosings.get(id);
  const config = this.options.settings.agents.find((agent) => agent.id === id);
  if (!config) throw new Error(`Agent ${id} 未登记。请使用 /agent list 查看可用 Agent。`);
  this.adapterUsedAt.set(id, Date.now());
  let pending = this.adapters.get(id);
  if (!pending) {
    this.adapterStates.set(id, "loading");
    pending = this.pluginHost()
      .then((host) => host.get(agentAdapterRegistryService).get(id))
      .then(
        (adapter) => {
          this.adapterStates.set(id, "loaded");
          this.changed();
          return adapter;
        },
        (error) => {
          this.adapterStates.set(id, "unavailable");
          if (this.adapters.get(id) === pending) this.adapters.delete(id);
          this.changed();
          throw error;
        },
      );
    this.adapters.set(id, pending);
    this.changed();
  }
  return pending;
}

export function binding(this: GatewayAdapterOwner, session: GatewaySession, agentId: string): Promise<GatewayBinding> {
  const id = `${session.id}:${agentId}`,
    prior = this.bindingJobs.get(id);
  if (prior) return prior;
  const job = createBinding.call(this, session, agentId);
  this.bindingJobs.set(id, job);
  void job.finally(() => this.bindingJobs.delete(id)).catch(() => undefined);
  return job;
}

async function createBinding(
  this: GatewayAdapterOwner,
  session: GatewaySession,
  agentId: string,
): Promise<GatewayBinding> {
  const id = `${session.id}:${agentId}`,
    existing = this.store.get<GatewayBinding>("bindings", id);
  if (existing?.status === "ready") return existing;
  const config = this.options.settings.agents.find((agent) => agent.id === agentId)!;
  const record: GatewayBinding = existing ?? {
    id,
    sessionId: session.id,
    agentId,
    requestId: randomUUID(),
    version: digest(config),
    status: "creating",
    usedAt: Date.now(),
  };
  this.store.put("bindings", id, record);
  const adapter = await resolveAdapter.call(this, agentId);
  if (existing) {
    const result = await adapter.inspectCreation?.(record.requestId);
    if (result?.status === "ready" && result.conversationId) {
      const ready = { ...record, status: "ready" as const, conversationId: result.conversationId };
      this.store.put("bindings", id, ready);
      return ready;
    }
    if (result?.status !== "not-started") throw new Error("Agent 对话创建结果需要核对，请查询适配器状态。");
  }
  try {
    const conversationId = await adapter.createConversation(record.requestId);
    const ready = { ...record, conversationId, status: "ready" as const };
    this.store.put("bindings", id, ready);
    return ready;
  } catch (error) {
    this.store.put("bindings", id, { ...record, status: "unknown", error: safeError(error) });
    throw error;
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Gateway 操作失败。";
}
