import { type AnyPlugin, type PluginHost } from "@may/plugin";
import { createMcpHostPlugin, createSharedMcpPlugin, mcpHostService, type McpPluginOptions } from "@may/plugin-mcp";
import { createObservabilityHostPlugin, createSharedObservabilityPlugin, observabilityHostService } from "@may/plugin-observability";
import type { MaybeCodeObservabilityOptions } from "../configured.js";
import { composeMaybeCodePlugins } from "./application.js";

export function createMaybeCodeResourcePlugins(options: {
  readonly dataDirectory: string;
  readonly observability: false | MaybeCodeObservabilityOptions;
  readonly mcp: false | McpPluginOptions;
}): AnyPlugin[] {
  return [
    ...(options.observability === false ? [] : [createObservabilityHostPlugin({
      ...options.observability,
      dataDirectory: options.dataDirectory,
      resourceAttributes: { "service.name": "maybecode" },
    })]),
    ...(options.mcp === false || options.mcp.servers.length === 0 ? [] : [createMcpHostPlugin({
      ...options.mcp,
      dataDirectory: options.dataDirectory,
    })]),
  ];
}

export function createMaybeCodeSharedPlugins(host: PluginHost, selected: readonly AnyPlugin[]): AnyPlugin[] {
  return composeMaybeCodePlugins([
    ...(host.provides(mcpHostService) ? [createSharedMcpPlugin(host.get(mcpHostService))] : []),
    ...(host.provides(observabilityHostService) ? [createSharedObservabilityPlugin(host.get(observabilityHostService))] : []),
  ], selected);
}
