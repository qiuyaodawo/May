import { createAgentAdaptersPlugin } from "@sortedyuan/plugin-agent-adapters";
import { createCoordinationPlugin } from "@sortedyuan/coordination/plugin";
import { loadGatewayAdapter } from "../gateway-adapters.js";
import type { GatewaySettings } from "../gateway-types.js";
import type { PermissionRuleStore } from "@sortedyuan/permissions";

export function createGatewayAgentPlugins(options: { directory: string; configPath: string; settings: GatewaySettings; permissionRuleStore?: () => Promise<PermissionRuleStore | undefined> }) {
  return [createAgentAdaptersPlugin({ factories: () => Object.fromEntries(options.settings.agents.map(agent => [agent.id,
    async () => {
      const ruleStore = options.settings.persistentRules && agent.adapter === "may" ? await options.permissionRuleStore?.() : undefined;
      return loadGatewayAdapter({ directory: options.directory, configPath: options.configPath, agent,
        ...(ruleStore === undefined ? {} : { permissionRuleStore: ruleStore }) });
    },
  ])) }), createCoordinationPlugin()];
}
