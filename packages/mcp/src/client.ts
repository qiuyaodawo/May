import { DefaultMcpClientPool } from "./client-pool.js";
import { freezeTree } from "./connection.js";
import { McpConfigurationError } from "./errors.js";
import { validateMcpServerOptions } from "./transports.js";
import type { McpClientPool, OpenMcpClientPoolOptions } from "./types.js";

/** @experimental */
export async function openMcpClientPool(options: OpenMcpClientPoolOptions): Promise<McpClientPool> {
  if (
    options.apps !== undefined &&
    (typeof options.apps.executor?.execute !== "function" || typeof options.apps.approve !== "function")
  )
    throw new McpConfigurationError("MCP Apps require a host permission executor and consent service");
  const serverIds = new Set<string>();
  for (const server of options.servers) {
    validateMcpServerOptions(server);
    if (server.tasks && options.taskJournal === undefined)
      throw new McpConfigurationError(`MCP server "${server.id}" enables Tasks without a task journal`);
    if (
      options.interactions !== undefined &&
      ((server.host?.roots && options.hostServices?.roots === undefined) ||
        (server.host?.sampling && options.hostServices?.sampling === undefined))
    )
      throw new McpConfigurationError(`MCP server "${server.id}" enables a missing host service`);
    if (serverIds.has(server.id)) throw new McpConfigurationError(`Duplicate MCP server id: ${server.id}`);
    serverIds.add(server.id);
  }
  // Configuration and its account/endpoint identity must not change underneath an open pool.
  const pool = new DefaultMcpClientPool({ ...options, servers: freezeTree(structuredClone(options.servers)) });
  await pool.initialize();
  return pool;
}
