import { join } from "node:path";
import { definePlugin, defineService } from "@may/plugin";
import { services } from "@may/plugin-services";
import { observabilityHostService } from "@may/plugin-observability";
import {
  openMcpClientPool, KeyringMcpCredentialStore, McpOAuthManager,
  McpTaskJournal, McpInteractionBroker,
  type McpClientPool, type OpenMcpClientPoolOptions,
} from "@may/mcp";

export const mcpService = defineService<McpClientPool>({ id: "may.mcp", version: "1.0.0", scope: "application" });
export const mcpHostService = defineService<McpClientPool>({ id: "may.workspace-mcp", version: "1.0.0", scope: "host" });

export interface McpPluginOptions extends OpenMcpClientPoolOptions {
  readonly dataDirectory?: string;
  readonly enableInteractions?: boolean;
  readonly open?: (options: OpenMcpClientPoolOptions) => Promise<McpClientPool>;
}

function configuredOptions(options: McpPluginOptions): OpenMcpClientPoolOptions {
  return {
    ...options,
    ...(options.enableInteractions === true && options.interactions === undefined ? { interactions: new McpInteractionBroker() } : {}),
    ...(options.dataDirectory === undefined ? {} : {
      ...(options.taskJournal === undefined && options.servers.some(server => server.tasks)
        ? { taskJournal: new McpTaskJournal(new KeyringMcpCredentialStore(join(options.dataDirectory, "mcp-tasks"))) } : {}),
      ...(options.oauth === undefined && options.servers.some(server => server.transport === "streamable-http" && server.auth !== undefined)
        ? { oauth: new McpOAuthManager(new KeyringMcpCredentialStore(join(options.dataDirectory, "mcp-credentials"))) } : {}),
    }),
  };
}

export function createMcpPlugin(options: McpPluginOptions) {
  return definePlugin({
    id: "may.mcp", version: "1.0.0", scope: "application", provides: [mcpService],
    requires: [{ service: services.toolSources }], optional: [{ service: services.tracer }],
    async setup(context) {
      const tracer = context.optional(services.tracer);
      const pool = await (options.open ?? openMcpClientPool)({
        ...configuredOptions(options), ...(tracer === undefined ? {} : { tracer }), signal: context.signal,
      });
      context.defer(() => pool.close());
      context.provide(mcpService, pool);
      context.defer(context.get(services.toolSources).add(() => pool.tools, { id: context.pluginId, pluginOrder: context.pluginOrder }));
    },
  });
}

export function createMcpHostPlugin(options: McpPluginOptions) {
  return definePlugin({
    id: "may.workspace-mcp", version: "1.0.0", scope: "host", provides: [mcpHostService],
    optional: [{ service: observabilityHostService }],
    async setup(context) {
      const tracer = context.optional(observabilityHostService)?.tracer;
      const pool = await (options.open ?? openMcpClientPool)({
        ...configuredOptions(options), ...(tracer === undefined ? {} : { tracer }), signal: context.signal,
      });
      context.defer(() => pool.close());
      context.provide(mcpHostService, pool);
    },
  });
}

export function createSharedMcpPlugin(pool: McpClientPool) {
  return definePlugin({
    id: "may.mcp", version: "1.0.0", scope: "application", provides: [mcpService],
    requires: [{ service: services.toolSources }],
    setup(context) {
      context.provide(mcpService, pool);
      context.defer(context.get(services.toolSources).add(() => pool.tools, { id: context.pluginId, pluginOrder: context.pluginOrder }));
    },
  });
}
