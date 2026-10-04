import { createAgentAdaptersPlugin } from "@may/plugin-agent-adapters";
import { createCoordinationPlugin } from "@may/plugin-coordination";
import { loadGatewayAdapter } from "../gateway-adapters.js";
import type { GatewaySettings } from "../gateway-types.js";
import type { PermissionRuleStore } from "@may/permissions";

export function createGatewayAgentPlugins(options: { directory: string; configPath: string; settings: GatewaySettings; permissionRuleStore?: () => Promise<PermissionRuleStore | undefined> }) {
  return [createAgentAdaptersPlugin({ factories: () => Object.fromEntries(options.settings.agents.map(agent => [agent.id,
    async () => {
      const ruleStore = options.settings.persistentRules && agent.adapter === "may" ? await options.permissionRuleStore?.() : undefined;
      return loadGatewayAdapter({ directory: options.directory, configPath: options.configPath, agent,
        ...(ruleStore === undefined ? {} : { permissionRuleStore: ruleStore }) });
    },
  ])) }), createCoordinationPlugin()];
}
