import {
  Client,
  type CallToolResult,
  type RequestOptions,
  type Tool as ProtocolTool,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  endTraceSpan,
  startTraceSpan,
  traceError,
  type JsonSchema,
  type Tool,
  type ToolExecutionContext,
  type TraceAttributes,
  type Tracer,
} from "@may/core";

import {
  McpClientPoolClosedError,
  McpConfigurationError,
  McpConnectionError,
  McpToolCallError,
  McpToolReportedError,
  McpToolsListError,
} from "./errors.js";
import { assertMcpServerId, namespaceMcpToolName } from "./names.js";
import type {
  McpClientPool,
  McpStdioServerOptions,
  McpToolOutput,
  OpenMcpClientPoolOptions,
} from "./types.js";

const DEFAULT_CLIENT_INFO = { name: "may-mcp-client", version: "0.1.0" };

class StdioMcpConnection {
  private closed = false;

  private constructor(
    readonly options: McpStdioServerOptions,
    private readonly client: Client,
    private readonly tracer: Tracer | undefined,
    private readonly traceAttributes: TraceAttributes,
  ) {}

  static async open(
    options: McpStdioServerOptions,
    poolOptions: OpenMcpClientPoolOptions,
  ): Promise<StdioMcpConnection> {
    validateServerOptions(options);
    const client = new Client(poolOptions.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {},
    });
    const transport = new StdioClientTransport({
      command: options.command,
      ...(options.args === undefined ? {} : { args: [...options.args] }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: { ...getDefaultEnvironment(), ...options.env } }),
      ...(options.maxBufferSize === undefined
        ? {}
        : { maxBufferSize: options.maxBufferSize }),
    });
    const traceAttributes = {
      ...(poolOptions.traceAttributes ?? {}),
      "may.mcp.server": options.id,
      "may.mcp.transport": "stdio",
    } as const;
    const span = startTraceSpan(poolOptions.tracer, "may.mcp.connect", {
      attributes: traceAttributes,
    });

    try {
      await client.connect(
        transport,
        requestOptions(options, poolOptions.signal),
      );
      endTraceSpan(span, {
        status: "ok",
        ...(transport.pid === null
          ? {}
          : { attributes: { "process.pid": transport.pid } }),
      });
      return new StdioMcpConnection(
        options,
        client,
        poolOptions.tracer,
        traceAttributes,
      );
    } catch (error) {
      endMcpSpan(span, error, poolOptions.signal);
      await closeQuietly(client);
      if (poolOptions.signal?.aborted === true) throw error;
      throw new McpConnectionError(
        options.id,
        errorMessage(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly Tool[]> {
    this.throwIfClosed();
    const span = startTraceSpan(this.tracer, "may.mcp.tools.list", {
      attributes: this.traceAttributes,
    });
    try {
      const result = await this.client.listTools(
        undefined,
        requestOptions(this.options, signal),
      );
      const tools = createTools(this, result.tools);
      endTraceSpan(span, {
        status: "ok",
        attributes: { "may.mcp.tools.count": tools.length },
      });
      return tools;
    } catch (error) {
      endMcpSpan(span, error, signal);
      if (signal?.aborted === true) throw error;
      throw new McpToolsListError(
        this.options.id,
        errorMessage(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async callTool(
    definition: ProtocolTool,
    exposedName: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<McpToolOutput> {
    this.throwIfClosed();
    const span = startTraceSpan(this.tracer, "may.mcp.tool.call", {
      ...(context.traceContext === undefined
        ? {}
        : { parent: context.traceContext }),
      attributes: {
        ...this.traceAttributes,
        "may.step": context.step,
        "may.tool.name": exposedName,
        "may.tool.call_id": context.toolCallId,
        "may.mcp.tool.remote_name": definition.name,
      },
    });

    try {
      const result = await this.client.callTool(
        { name: definition.name, arguments: input },
        {
          ...requestOptions(this.options, context.signal),
          resetTimeoutOnProgress: true,
          toolDefinition: definition,
          onprogress: (progress) => {
            context.report({
              type: "progress",
              message: formatProgress(progress),
              data: progress,
            });
          },
        },
      );
      if (result.isError === true) {
        throw new McpToolReportedError(
          this.options.id,
          definition.name,
          describeToolError(result),
        );
      }

      endTraceSpan(span, { status: "ok" });
      return {
        content: result.content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      };
    } catch (error) {
      endMcpSpan(span, error, context.signal);
      if (context.signal.aborted || error instanceof McpToolReportedError) {
        throw error;
      }
      throw new McpToolCallError(
        this.options.id,
        definition.name,
        errorMessage(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const span = startTraceSpan(this.tracer, "may.mcp.disconnect", {
      attributes: this.traceAttributes,
    });
    try {
      await this.client.close();
      endTraceSpan(span, { status: "ok" });
    } catch (error) {
      endMcpSpan(span, error);
      throw new McpConnectionError(
        this.options.id,
        `disconnect failed: ${errorMessage(error)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new McpClientPoolClosedError();
  }
}

class DefaultMcpClientPool implements McpClientPool {
  readonly tools: readonly Tool[];
  private closed = false;

  constructor(
    private readonly connections: readonly StdioMcpConnection[],
    tools: readonly Tool[],
  ) {
    this.tools = Object.freeze([...tools]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const connection of [...this.connections].reverse()) {
      try {
        await connection.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more MCP clients failed to close");
    }
  }
}

export async function openMcpClientPool(
  options: OpenMcpClientPoolOptions,
): Promise<McpClientPool> {
  const serverIds = new Set<string>();
  for (const server of options.servers) {
    validateServerOptions(server);
    if (serverIds.has(server.id)) {
      throw new McpConfigurationError(`Duplicate MCP server id: ${server.id}`);
    }
    serverIds.add(server.id);
  }

  const connections: StdioMcpConnection[] = [];
  const tools: Tool[] = [];
  const exposedNames = new Set<string>();
  try {
    for (const server of options.servers) {
      options.signal?.throwIfAborted();
      const connection = await StdioMcpConnection.open(server, options);
      connections.push(connection);
      for (const tool of await connection.listTools(options.signal)) {
        if (exposedNames.has(tool.name)) {
          throw new McpConfigurationError(
            `MCP tool namespace collision: ${tool.name}`,
          );
        }
        exposedNames.add(tool.name);
        tools.push(tool);
      }
    }
    return new DefaultMcpClientPool(connections, tools);
  } catch (error) {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    throw error;
  }
}

function createTools(
  connection: StdioMcpConnection,
  definitions: readonly ProtocolTool[],
): readonly Tool[] {
  return definitions.map((definition) => {
    const exposedName = namespaceMcpToolName(
      connection.options.id,
      definition.name,
    );
    return {
      name: exposedName,
      description: `[MCP server: ${connection.options.id}] ${
        definition.description ?? definition.name
      }`,
      inputSchema: definition.inputSchema as JsonSchema,
      parse: (input: unknown) => parseArguments(exposedName, input),
      execute: (input: Record<string, unknown>, context: ToolExecutionContext) =>
        connection.callTool(definition, exposedName, input, context),
    };
  });
}

function parseArguments(
  exposedName: string,
  input: unknown,
): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`MCP tool "${exposedName}" input must be an object`);
  }
  return input as Record<string, unknown>;
}

function validateServerOptions(options: McpStdioServerOptions): void {
  assertMcpServerId(options.id);
  if (options.command.trim() === "") {
    throw new McpConfigurationError(
      `MCP server "${options.id}" command must be a non-empty string`,
    );
  }
  for (const argument of options.args ?? []) {
    if (typeof argument !== "string") {
      throw new McpConfigurationError(
        `MCP server "${options.id}" arguments must be strings`,
      );
    }
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (name === "" || typeof value !== "string") {
      throw new McpConfigurationError(
        `MCP server "${options.id}" environment entries must be string pairs`,
      );
    }
  }
  positiveNumber(options.requestTimeoutMs, options.id, "requestTimeoutMs");
  positiveNumber(options.maxTotalTimeoutMs, options.id, "maxTotalTimeoutMs");
  positiveNumber(options.maxBufferSize, options.id, "maxBufferSize");
}

function positiveNumber(
  value: number | undefined,
  serverId: string,
  name: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new McpConfigurationError(
      `MCP server "${serverId}" ${name} must be a positive number`,
    );
  }
}

function requestOptions(
  options: McpStdioServerOptions,
  signal?: AbortSignal,
): RequestOptions {
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { timeout: options.requestTimeoutMs }),
    ...(options.maxTotalTimeoutMs === undefined
      ? {}
      : { maxTotalTimeout: options.maxTotalTimeoutMs }),
  };
}

function formatProgress(progress: unknown): string {
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

function describeToolError(result: CallToolResult): string {
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

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 1)}…`;
}

function endMcpSpan(
  span: ReturnType<typeof startTraceSpan>,
  error: unknown,
  signal?: AbortSignal,
): void {
  endTraceSpan(span, {
    status: signal?.aborted === true ? "cancelled" : "error",
    error: traceError(error),
  });
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Preserve the connection failure that caused cleanup.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
