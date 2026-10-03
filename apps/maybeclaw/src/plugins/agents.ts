import { createAgentAdaptersPlugin } from "@may/plugin-agent-adapters";
import { createCoordinationPlugin } from "@may/plugin-coordination";
import { loadGatewayAdapter } from "../gateway-adapters.js";
import type { GatewaySettings } from "../gateway-types.js";

export function createGatewayAgentPlugins(options: { directory: string; configPath: string; settings: GatewaySettings }) {
  return [createAgentAdaptersPlugin({ factories: () => Object.fromEntries(options.settings.agents.map(agent => [agent.id,
    () => loadGatewayAdapter({ directory: options.directory, configPath: options.configPath, agent }),
  ])) }), createCoordinationPlugin()];
}
