import type { RequestOptions } from "@modelcontextprotocol/client";
import { omitUndefined } from "@sortedyuan/may/core";

import { McpCatalogError } from "./errors.js";
import type { McpHostClient } from "./host-client.js";
import { namespaceMcpToolName } from "./names.js";
import type { McpServerCatalog } from "./types.js";

export async function listMcpCatalog(
  client: McpHostClient,
  serverId: string,
  options: RequestOptions,
): Promise<Omit<McpServerCatalog, "revision" | "serverId">> {
  const capabilities = client.getServerCapabilities() ?? {};
  // Explicit page walking rejects repeated cursors rather than publishing a partial catalog.
  const tools =
    capabilities.tools === undefined
      ? []
      : await listAll(serverId, async (cursor) => {
          const result = await client.request({ method: "tools/list", params: omitUndefined({ cursor }) }, options);
          return { items: result.tools, nextCursor: result.nextCursor };
        });
  const resources =
    capabilities.resources === undefined
      ? []
      : await listAll(serverId, async (cursor) => {
          const result = await client.request({ method: "resources/list", params: omitUndefined({ cursor }) }, options);
          return { items: result.resources, nextCursor: result.nextCursor };
        });
  const resourceTemplates =
    capabilities.resources === undefined
      ? []
      : await listAll(serverId, async (cursor) => {
          const result = await client.request(
            { method: "resources/templates/list", params: omitUndefined({ cursor }) },
            options,
          );
          return { items: result.resourceTemplates, nextCursor: result.nextCursor };
        });
  const prompts =
    capabilities.prompts === undefined
      ? []
      : await listAll(serverId, async (cursor) => {
          const result = await client.request({ method: "prompts/list", params: omitUndefined({ cursor }) }, options);
          return { items: result.prompts, nextCursor: result.nextCursor };
        });
  const catalog = { capabilities, tools, resources, resourceTemplates, prompts };
  if (
    tools.length + resources.length + resourceTemplates.length + prompts.length > 4096 ||
    Buffer.byteLength(JSON.stringify(catalog)) > 8 * 1024 * 1024
  ) {
    throw new McpCatalogError(serverId, "catalog exceeds host limits");
  }
  assertUnique(
    tools.map((tool) => namespaceMcpToolName(serverId, tool.name)),
    serverId,
  );
  assertUnique(
    resources.map((resource) => resource.uri),
    serverId,
  );
  assertUnique(
    resourceTemplates.map((template) => template.uriTemplate),
    serverId,
  );
  assertUnique(
    prompts.map((prompt) => prompt.name),
    serverId,
  );
  return catalog;
}

function assertUnique(values: readonly string[], serverId: string): void {
  if (new Set(values).size !== values.length) throw new McpCatalogError(serverId, "duplicate catalog identity");
}

async function listAll<T>(
  serverId: string,
  page: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor: string | undefined }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let count = 0; count < 64; count++) {
    const result = await page(cursor);
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (items.length + result.items.length > 4096 || bytes > 8 * 1024 * 1024) {
      throw new McpCatalogError(serverId, "catalog exceeds host limits");
    }
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === undefined) return items;
    if (seen.has(cursor)) throw new McpCatalogError(serverId, "catalog cursor repeated");
    seen.add(cursor);
  }
  throw new McpCatalogError(serverId, "catalog pagination exceeds 64 pages");
}
