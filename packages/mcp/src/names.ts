import { createHash } from "node:crypto";

import { McpConfigurationError } from "./errors.js";

const MAX_TOOL_NAME_LENGTH = 64;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function assertMcpServerId(id: string): void {
  if (id.trim() === "" || id !== id.trim()) {
    throw new McpConfigurationError(
      "MCP server id must be a non-empty string without surrounding whitespace",
    );
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new McpConfigurationError(
      `MCP server id "${id}" may contain only letters, digits, underscores, and hyphens`,
    );
  }
}

/** Create a provider-safe, collision-resistant model-facing tool name. */
export function namespaceMcpToolName(
  serverId: string,
  remoteToolName: string,
): string {
  assertMcpServerId(serverId);
  if (remoteToolName.trim() === "") {
    throw new McpConfigurationError(
      `MCP server "${serverId}" returned a tool with an empty name`,
    );
  }

  const readableName = remoteToolName
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || "tool";
  const candidate = `mcp__${serverId}__${readableName}`;
  if (candidate.length <= MAX_TOOL_NAME_LENGTH) return candidate;

  const digest = createHash("sha256")
    .update(`${serverId}\0${remoteToolName}`)
    .digest("hex")
    .slice(0, 10);
  return `${candidate.slice(0, MAX_TOOL_NAME_LENGTH - digest.length - 1)}_${digest}`;
}
