import { join } from "node:path";
import { AgentDefinition, defineAgent } from "@may/application";
import { loadMayConfig } from "@may/config";
import { createReadTool } from "@may/coding-tools";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import { loadPluginModules, parsePluginSelections, type AnyPlugin } from "@may/plugin";
import { createMayAgentAdapter, loadAgentAdapter } from "@may/plugin-agent-adapters";
import { createModelPlugin } from "@may/plugin-models";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { createToolsPlugin } from "@may/plugin-runtime";
import { services } from "@may/plugin-services";
import type { GatewayAgentAdapter, GatewayAgentConfig, GatewayAdapterContext } from "./gateway-types.js";

export interface MayAdapterOptions {
  plugins?: readonly AnyPlugin[];
  directory: string;
  configPath: string;
  agent: GatewayAgentConfig;
  definition?: (tools: () => GatewayAdapterContext["tools"]) => Promise<AgentDefinition> | AgentDefinition;
}

export async function loadGatewayAdapter(options: MayAdapterOptions): Promise<GatewayAgentAdapter> {
  if (options.agent.adapter === "may") {
    if (!options.definition) {
      const config = await loadMayConfig({ path: options.configPath });
      const plugins = options.plugins ?? await loadPluginModules(parsePluginSelections(options.agent.plugins), config.path);
      if (!plugins.some(plugin => plugin.provides?.some(service => service.id === services.model.id && service.scope === services.model.scope))) selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {});
      return createMayAdapter({ ...options, plugins });
    }
    return createMayAdapter(options);
  }
  return loadAgentAdapter({ ...options.agent, module: options.agent.module! }, { ...options });
}

export function createMayAdapter(options: MayAdapterOptions): GatewayAgentAdapter {
  return createMayAgentAdapter({ agentId: options.agent.id,
    store: new FileSessionStore(join(options.directory, "agents", options.agent.id, "sessions")),
    ...(options.agent.media ? { media: options.agent.media } : {}),
    metadata: conversationId => ({ maybeclaw: { agentId: options.agent.id, conversationId } }),
    definition: options.definition ?? (async source => {
      const config = await loadMayConfig({ path: options.configPath });
      const selected = options.plugins ?? await loadPluginModules(parsePluginSelections(options.agent.plugins), config.path);
      const defaults = [
        createModelPlugin({ create: () => createBuiltinProviderModel(selectProviderModel(config, options.agent.model ? { model: options.agent.model } : {})) }),
        createPermissionPlugin({ create: () => check => options.agent.permissions?.[check.tool.name]
          ?? (["list_agents", "delegate_tasks", "send_message", "wait_for_messages", "handoff_task", "read"].includes(check.tool.name) ? "allow" : "ask") }),
        createToolsPlugin({ id: "maybeclaw.tools", create: () => {
          const tools = options.agent.readDirectory ? [createReadTool({ cwd: options.agent.readDirectory })] : [];
          return () => [...tools, ...source()];
        } }),
      ];
      const ids = new Set(selected.map(plugin => plugin.id));
      const provided = new Set(selected.flatMap(plugin => plugin.provides?.map(service => `${service.scope}:${service.id}`) ?? []));
      return defineAgent({
        plugins: [...defaults.filter(plugin => !ids.has(plugin.id) && !plugin.provides?.some(service => provided.has(`${service.scope}:${service.id}`))), ...selected],
        ...(options.agent.instructions === undefined ? {} : { instructions: options.agent.instructions }),
        ...(options.agent.runBudget ? { runBudget: options.agent.runBudget } : {}),
      });
    }),
  });
}
