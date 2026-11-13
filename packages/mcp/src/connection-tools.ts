import type { CallToolResult, Tool as ProtocolTool } from "@modelcontextprotocol/client";
import type { JsonSchema, Tool, ToolExecutionContext } from "@sortedyuan/may/core";

import type { McpConnection } from "./connection.js";
import { mcpToolResultContent } from "./content.js";
import { namespaceMcpToolName } from "./names.js";
import { truncate } from "./transport-support.js";
import type { McpToolOutput } from "./types.js";
import { fingerprint, freezeTree } from "./value-support.js";

export function createTools(connection: McpConnection, definitions: readonly ProtocolTool[]): readonly Tool[] {
  return definitions.map((original) => {
    validateToolSchema(original.inputSchema);
    const definition = freezeTree(structuredClone(original));
    const generation = connection.generation;
    const exposedName = namespaceMcpToolName(connection.options.id, definition.name);
    return Object.freeze({
      name: exposedName,
      permissionVersion: fingerprint([connection.options, generation, definition]),
      description: `[MCP server: ${connection.options.id}] ${definition.description ?? definition.name}`,
      inputSchema: definition.inputSchema as JsonSchema,
      parse: (input: unknown) => parseArguments(exposedName, input),
      resultContent: (output: McpToolOutput) => mcpToolResultContent(connection.options.id, definition.name, output),
      execute: (input: Record<string, unknown>, context: ToolExecutionContext) =>
        connection.callTool(definition, exposedName, input, context, generation),
    });
  });
}

function validateToolSchema(value: unknown): void {
  const invalid = () => {
    throw new TypeError("MCP tool inputSchema is invalid or exceeds host limits");
  };
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { type?: unknown }).type !== "object")
    invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) invalid();
  let nodes = 0;
  const visit = (schema: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 32) invalid();
    if (typeof schema === "boolean") return;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) invalid();
    const record = schema as Record<string, unknown>;
    if (record.type !== undefined) {
      const types = typeof record.type === "string" ? [record.type] : Array.isArray(record.type) ? record.type : [];
      if (
        types.length === 0 ||
        !types.every((type) => ["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))
      )
        invalid();
    }
    if (
      record.required !== undefined &&
      (!Array.isArray(record.required) ||
        record.required.some((key) => typeof key !== "string") ||
        new Set(record.required).size !== record.required.length)
    )
      invalid();
    for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
      const children = record[key];
      if (children === undefined) continue;
      if (!children || typeof children !== "object" || Array.isArray(children)) invalid();
      for (const child of Object.values(children as object)) visit(child, depth + 1);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      const children = record[key];
      if (children === undefined) continue;
      if (!Array.isArray(children)) invalid();
      for (const child of children as unknown[]) visit(child, depth + 1);
    }
    for (const key of ["items", "additionalProperties", "not", "if", "then", "else", "contains"] as const) {
      const child = record[key];
      if (child !== undefined) {
        if (key === "items" && Array.isArray(child)) for (const entry of child) visit(entry, depth + 1);
        else visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function parseArguments(exposedName: string, input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`MCP tool "${exposedName}" input must be an object`);
  }
  return input as Record<string, unknown>;
}

export function formatProgress(progress: unknown): string {
  if (typeof progress !== "object" || progress === null) {
    return "MCP tool reported progress";
  }
  const record = progress as Record<string, unknown>;
  if (typeof record.message === "string" && record.message !== "") {
    return record.message;
  }
  if (typeof record.progress === "number") {
    return typeof record.total === "number"
      ? `MCP tool progress: ${record.progress}/${record.total}`
      : `MCP tool progress: ${record.progress}`;
  }
  return "MCP tool reported progress";
}

export function describeToolError(result: CallToolResult): string {
  const text = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (text !== "") return truncate(text, 4_000);
  try {
    return truncate(JSON.stringify(result.content), 4_000);
  } catch {
    return "The remote tool returned isError=true";
  }
}
