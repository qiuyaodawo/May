import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { definePlugin, defineService, type PluginDefinition } from "@may/plugin";
import type { AgentAdapter, AgentAdapterConfig, AgentAdapterRegistry } from "./types.js";
export * from "./types.js";
export * from "./may.js";
export * from "./rpc.js";

export function validateAgentAdapter(adapter: AgentAdapter, id: string): void {
  if (!adapter || !adapter.capabilities || ["createConversation", "execute", "inspect", "close"].some(key => typeof adapter[key as keyof AgentAdapter] !== "function")) throw new Error(`Agent ${id} 的适配器接口不完整。`);
  if (["cancel", "steer", "resume", "delete", "approvals", "collaboration"].some(key => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== "boolean")
    || !Array.isArray(adapter.capabilities.media) || adapter.capabilities.media.some(value => !["image", "audio", "file", "video"].includes(value))) throw new Error(`Agent ${id} 的能力声明不合法。`);
  for (const [flag, method] of [["cancel", "cancel"], ["steer", "steer"], ["steer", "steeringInputs"], ["delete", "deleteConversation"], ["approvals", "resolveApproval"]] as const) {
    if (adapter.capabilities[flag] && typeof adapter[method] !== "function") throw new Error(`Agent ${id} 缺少 ${method}。`);
  }
}
export async function loadAgentAdapter(config: AgentAdapterConfig, factoryContext: Record<string, unknown> = {}): Promise<AgentAdapter> {
  const module = await import(isAbsolute(config.module) || config.module.startsWith(".") ? pathToFileURL(resolve(config.module)).href : config.module);
  const factory: unknown = module[config.export ?? "createAdapter"];
  if (typeof factory !== "function") throw new Error(`Agent ${config.id} 的模块没有导出 createAdapter。`);
  const adapter: AgentAdapter = await factory({ ...factoryContext, agent: config, options: config.options ?? {} });
  try { validateAgentAdapter(adapter, config.id); return adapter; }
  catch (error) { if (typeof adapter?.close === "function") await adapter.close(); throw error; }
}
export const agentAdapterRegistryService = defineService<AgentAdapterRegistry>({ id: "may.agent-adapters", version: "1.0.0", scope: "host" });
export type AgentAdapterFactories = Readonly<Record<string, () => AgentAdapter | Promise<AgentAdapter>>>;
export function createAgentAdaptersPlugin(options: { readonly factories: AgentAdapterFactories | (() => AgentAdapterFactories); readonly id?: string }): PluginDefinition {
  const staticFactories = typeof options.factories === "function" ? undefined : { ...options.factories };
  const factoriesOf = typeof options.factories === "function" ? options.factories : () => staticFactories!;
  return definePlugin({
    id: options.id ?? "@may/plugin-agent-adapters", version: "0.1.0", scope: "host", provides: [agentAdapterRegistryService],
    setup(context) {
      const opened = new Map<string, Promise<AgentAdapter>>(), releasing = new Map<string, Promise<void>>();
      const registry: AgentAdapterRegistry = {
        async get(id) {
          context.signal.throwIfAborted();
          if (releasing.has(id)) await releasing.get(id);
          const existing = opened.get(id); if (existing) return existing;
          context.signal.throwIfAborted();
          const factories = factoriesOf();
          const factory = Object.hasOwn(factories, id) ? factories[id] : undefined;
          if (!factory) throw new Error(`Unknown Agent adapter: ${id}`);
          const opening = Promise.resolve().then(factory).then(async adapter => {
            try { validateAgentAdapter(adapter, id); context.signal.throwIfAborted(); return adapter; }
            catch (error) { if (typeof adapter?.close === "function") await adapter.close(); throw error; }
          }).catch(error => { opened.delete(id); throw error; });
          opened.set(id, opening); return opening;
        },
        release(id) {
          const prior = releasing.get(id); if (prior) return prior;
          const adapter = opened.get(id); if (!adapter) return Promise.resolve();
          const closing = adapter.then(value => value.close(), () => undefined).finally(() => { opened.delete(id); releasing.delete(id); });
          releasing.set(id, closing); return closing;
        },
        list: () => Object.keys(factoriesOf()),
      };
      context.provide(agentAdapterRegistryService, registry);
      context.defer(async () => {
        const results = await Promise.allSettled([...opened.keys()].map(id => registry.release(id)));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "Agent adapter cleanup failed");
      });
    },
  });
}
