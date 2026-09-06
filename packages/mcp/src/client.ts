import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type RequestOptions,
  type Tool as ProtocolTool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  AsyncEventQueue,
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
import { namespaceMcpToolName } from "./names.js";
import { McpAuthenticationError } from "./oauth.js";
import { McpCredentialStoreError } from "./credentials.js";
import {
  createMcpTransport,
  safeMcpTransportError,
  validateMcpServerOptions,
} from "./transports.js";
import type {
  McpClientPool,
  McpClientEvent,
  McpDiagnostic,
  McpServerStatus,
  McpServerOptions,
  McpToolOutput,
  OpenMcpClientPoolOptions,
} from "./types.js";

const DEFAULT_CLIENT_INFO = { name: "may-mcp-client", version: "0.1.0" };
const DEFAULT_STDERR_MAX_BYTES = 16 * 1_024;

class McpConnection {
  private closed = false;
  private closing = false;
  private connected = false;
  private lastTransportError: Error | undefined;

  private constructor(
    readonly options: McpServerOptions,
    private readonly client: Client,
    private readonly transport: ReturnType<typeof createMcpTransport>,
    private readonly stderr: BoundedStderrBuffer,
    private readonly tracer: Tracer | undefined,
    private readonly traceAttributes: TraceAttributes,
    private readonly onAvailability: (error?: Error) => void,
  ) {}

  static async open(
    options: McpServerOptions,
    poolOptions: OpenMcpClientPoolOptions,
    onAvailability: (error?: Error) => void,
  ): Promise<McpConnection> {
    validateMcpServerOptions(options);
    const client = new Client(poolOptions.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {},
      versionNegotiation: {
        mode: options.protocolMode ?? (options.transport === "streamable-http" ? "auto" : "legacy"),
        probe: {
          timeoutMs: Math.min(
            options.requestTimeoutMs ?? 60_000,
            options.maxTotalTimeoutMs ?? Infinity,
          ),
          maxRetries: 0,
        },
      },
    });
    const stderr = new BoundedStderrBuffer(
      options.transport === "streamable-http"
        ? 0 : options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
    );
    const transport = createMcpTransport(options, poolOptions.oauth);
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: unknown) => stderr.append(chunk));
    }
    const traceAttributes = {
      ...(poolOptions.traceAttributes ?? {}),
      "may.mcp.server": options.id,
      "may.mcp.transport": options.transport ?? "stdio",
    } as const;
    const span = startTraceSpan(poolOptions.tracer, "may.mcp.connect", {
      attributes: traceAttributes,
    });
    const connection = new McpConnection(
      options,
      client,
      transport,
      stderr,
      poolOptions.tracer,
      traceAttributes,
      onAvailability,
    );
    client.onerror = (error) => {
      connection.lastTransportError = safeMcpTransportError(error, options) as Error;
    };
    client.onclose = () => connection.handleClose();

    // SDK discovery precedes Protocol request registration. Close the raw
    // transport on cancellation so both HTTP probes and stdio siblings stop.
    const abortConnect = () => { void transport.close().catch(() => {}); };
    poolOptions.signal?.addEventListener("abort", abortConnect, { once: true });
    try {
      poolOptions.signal?.throwIfAborted();
      await client.connect(
        transport,
        requestOptions(options, poolOptions.signal),
      );
      poolOptions.signal?.throwIfAborted();
      endTraceSpan(span, {
        status: "ok",
        ...(!(transport instanceof StdioClientTransport) || transport.pid === null
          ? {}
          : { attributes: { "process.pid": transport.pid } }),
      });
      connection.connected = true;
      return connection;
    } catch (error) {
      const safeError = safeMcpTransportError(error, options);
      endMcpSpan(span, safeError, poolOptions.signal);
      await closeQuietly(client);
      poolOptions.signal?.throwIfAborted();
      const recentStderr = stderr.text();
      if (safeError instanceof McpAuthenticationError || safeError instanceof McpCredentialStoreError) throw safeError;
      throw new McpConnectionError(
        options.id,
        sanitizeDiagnosticText(errorMessage(safeError), 2_000),
        {
          ...(safeError instanceof Error ? { cause: safeError } : {}),
          ...(recentStderr === undefined ? {} : { stderr: recentStderr }),
        },
      );
    } finally {
      poolOptions.signal?.removeEventListener("abort", abortConnect);
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
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, signal);
      if (signal?.aborted === true) throw error;
      if (safeError instanceof McpAuthenticationError || safeError instanceof McpCredentialStoreError) throw safeError;
      const recentStderr = this.stderr.text();
      throw new McpToolsListError(
        this.options.id,
        sanitizeDiagnosticText(errorMessage(safeError), 2_000),
        {
          ...(safeError instanceof Error ? { cause: safeError } : {}),
          ...(recentStderr === undefined ? {} : { stderr: recentStderr }),
        },
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

      this.onAvailability();
      endTraceSpan(span, { status: "ok" });
      return {
        content: result.content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      };
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, context.signal);
      if (context.signal.aborted || error instanceof McpToolReportedError) {
        throw error;
      }
      if (safeError instanceof McpAuthenticationError || safeError instanceof McpCredentialStoreError) {
        this.onAvailability(safeError);
        throw safeError;
      }
      throw new McpToolCallError(
        this.options.id,
        definition.name,
        errorMessage(safeError),
        safeError instanceof Error ? { cause: safeError } : undefined,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    const span = startTraceSpan(this.tracer, "may.mcp.disconnect", {
      attributes: this.traceAttributes,
    });
    try {
      try {
        if (this.transport instanceof StreamableHTTPClientTransport) {
          await this.transport.terminateSession();
        }
      } finally {
        await this.client.close();
      }
      endTraceSpan(span, { status: "ok" });
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError);
      const recentStderr = this.stderr.text();
      throw new McpConnectionError(
        this.options.id,
        `disconnect failed: ${errorMessage(safeError)}`,
        {
          ...(safeError instanceof Error ? { cause: safeError } : {}),
          ...(recentStderr === undefined ? {} : { stderr: recentStderr }),
        },
      );
    }
  }

  protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  stderrText(): string | undefined {
    return this.stderr.text();
  }

  private throwIfClosed(): void {
    if (this.closed) throw new McpClientPoolClosedError();
  }

  private handleClose(): void {
    if (this.closing || this.closed || !this.connected) return;
    this.closed = true;
    const recentStderr = this.stderr.text();
    const cause = this.lastTransportError;
    this.onAvailability(new McpConnectionError(
      this.options.id,
      cause === undefined
        ? "connection closed unexpectedly"
        : `connection closed unexpectedly: ${sanitizeDiagnosticText(
            cause.message,
            2_000,
          )}`,
      {
        ...(cause === undefined ? {} : { cause }),
        ...(recentStderr === undefined ? {} : { stderr: recentStderr }),
      },
    ));
  }
}

interface MutableMcpServerStatus {
  readonly serverId: string;
  readonly transport: McpServerStatus["transport"];
  protocolVersion?: string;
  readonly required: boolean;
  state: McpServerStatus["state"];
  toolNames: readonly string[];
  diagnostic?: McpDiagnostic;
}

class McpEventRecorder {
  readonly events: AsyncIterable<McpClientEvent>;
  private readonly queue = new AsyncEventQueue<McpClientEvent>({
    maxBufferedValues: 256,
  });
  private sequence = 0;

  constructor() {
    this.events = this.queue;
  }

  connected(
    server: McpServerOptions,
    toolNames: readonly string[],
  ): void {
    this.queue.push({
      type: "mcp.server.connected",
      seq: ++this.sequence,
      timestamp: Date.now(),
      serverId: server.id,
      transport: server.transport ?? "stdio",
      required: server.required !== false,
      toolNames: [...toolNames],
    });
  }

  failed(server: McpServerOptions, diagnostic: McpDiagnostic): void {
    this.queue.push({
      type: "mcp.server.failed",
      seq: ++this.sequence,
      timestamp: Date.now(),
      serverId: server.id,
      transport: server.transport ?? "stdio",
      required: server.required !== false,
      diagnostic: { ...diagnostic },
    });
  }

  disconnected(server: McpServerOptions): void {
    this.queue.push({
      type: "mcp.server.disconnected",
      seq: ++this.sequence,
      timestamp: Date.now(),
      serverId: server.id,
      transport: server.transport ?? "stdio",
      required: server.required !== false,
    });
  }

  close(): void {
    this.queue.close();
  }
}

class DefaultMcpClientPool implements McpClientPool {
  readonly tools: readonly Tool[];
  readonly events: AsyncIterable<McpClientEvent>;
  private closed = false;

  constructor(
    private readonly connections: readonly McpConnection[],
    private readonly statuses: MutableMcpServerStatus[],
    private readonly eventRecorder: McpEventRecorder,
    tools: readonly Tool[],
  ) {
    this.tools = Object.freeze([...tools]);
    this.events = eventRecorder.events;
  }

  status(): readonly McpServerStatus[] {
    return this.statuses.map((status) => {
      const stderr = this.connections.find((connection) =>
        connection.options.id === status.serverId
      )?.stderrText() ?? status.diagnostic?.stderr;
      return {
        serverId: status.serverId,
        transport: status.transport,
        ...(status.protocolVersion === undefined ? {} : { protocolVersion: status.protocolVersion }),
        required: status.required,
        state: status.state,
        toolNames: [...status.toolNames],
        ...(stderr === undefined ? {} : { stderr }),
        ...(status.diagnostic === undefined
          ? {}
          : { diagnostic: { ...status.diagnostic } }),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const connection of [...this.connections].reverse()) {
      const status = this.statuses.find((candidate) =>
        candidate.serverId === connection.options.id
      )!;
      if (status.state === "failed") {
        await closeConnectionQuietly(connection);
        continue;
      }
      try {
        await connection.close();
        status.state = "disconnected";
        this.eventRecorder.disconnected(connection.options);
      } catch (error) {
        failures.push(error);
        status.state = "failed";
        status.diagnostic = toDiagnostic(error);
        this.eventRecorder.failed(connection.options, status.diagnostic);
      }
    }
    this.eventRecorder.close();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more MCP clients failed to close",
      );
    }
  }
}

export async function openMcpClientPool(
  options: OpenMcpClientPoolOptions,
): Promise<McpClientPool> {
  const serverIds = new Set<string>();
  for (const server of options.servers) {
    validateMcpServerOptions(server);
    if (serverIds.has(server.id)) {
      throw new McpConfigurationError(`Duplicate MCP server id: ${server.id}`);
    }
    serverIds.add(server.id);
  }

  const connections: McpConnection[] = [];
  const statuses: MutableMcpServerStatus[] = options.servers.map((server) => ({
    serverId: server.id,
    transport: server.transport ?? "stdio",
    required: server.required !== false,
    state: "failed",
    toolNames: [],
  }));
  const tools: Tool[] = [];
  const exposedNames = new Set<string>();
  const eventRecorder = new McpEventRecorder();

  for (const server of options.servers) {
    const required = server.required !== false;
    const status = statuses.find((candidate) =>
      candidate.serverId === server.id
    )!;
    let connection: McpConnection | undefined;
    try {
      options.signal?.throwIfAborted();
      connection = await McpConnection.open(
        server,
        options,
        (error) => {
          if (error === undefined) {
            if (status.state === "auth-required") {
              status.state = "connected";
              delete status.diagnostic;
              eventRecorder.connected(server, status.toolNames);
            }
            return;
          }
          if (status.state !== "connected") return;
          status.state = error instanceof McpAuthenticationError && error.code === "MCP_AUTHENTICATION_REQUIRED"
            ? "auth-required" : "failed";
          status.diagnostic = toDiagnostic(error);
          eventRecorder.failed(server, status.diagnostic);
        },
      );
      const serverTools = await connection.listTools(options.signal);
      const serverNames = new Set<string>();
      for (const tool of serverTools) {
        if (exposedNames.has(tool.name) || serverNames.has(tool.name)) {
          throw new McpConfigurationError(
            `MCP tool namespace collision: ${tool.name}`,
          );
        }
        serverNames.add(tool.name);
      }

      connections.push(connection);
      tools.push(...serverTools);
      for (const name of serverNames) {
        exposedNames.add(name);
      }
      const toolNames = serverTools.map((tool) => tool.name);
      const protocolVersion = connection.protocolVersion();
      if (protocolVersion !== undefined) status.protocolVersion = protocolVersion;
      status.state = "connected";
      status.toolNames = toolNames;
      eventRecorder.connected(server, toolNames);
    } catch (error) {
      await closeConnectionQuietly(connection);
      const diagnostic = toDiagnostic(error);
      status.state = diagnostic.code === "MCP_AUTHENTICATION_REQUIRED" ? "auth-required" : "failed";
      status.toolNames = [];
      status.diagnostic = diagnostic;
      eventRecorder.failed(server, diagnostic);

      if (options.signal?.aborted === true || required) {
        await Promise.allSettled(
          connections.map((opened) => opened.close()),
        );
        eventRecorder.close();
        throw error;
      }
    }
  }

  return new DefaultMcpClientPool(
    connections,
    statuses,
    eventRecorder,
    tools,
  );
}

function createTools(
  connection: McpConnection,
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

function requestOptions(
  options: McpServerOptions,
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

async function closeConnectionQuietly(
  connection: McpConnection | undefined,
): Promise<void> {
  try {
    await connection?.close();
  } catch {
    // Preserve the startup failure that caused cleanup.
  }
}

function toDiagnostic(error: unknown): McpDiagnostic {
  const summary = error instanceof McpConnectionError ||
      error instanceof McpToolsListError
    ? error.summary
    : errorMessage(error);
  const code = error instanceof Error && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
  const stderr = error instanceof McpConnectionError ||
      error instanceof McpToolsListError
    ? error.stderr
    : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: sanitizeDiagnosticText(summary, 2_000),
    ...(code === undefined ? {} : { code }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

class BoundedStderrBuffer {
  private value = Buffer.alloc(0);

  constructor(private readonly maximumBytes: number) {}

  append(value: unknown): void {
    const incoming = Buffer.isBuffer(value)
      ? value
      : Buffer.from(String(value), "utf8");
    if (incoming.length >= this.maximumBytes) {
      this.value = Buffer.from(
        incoming.subarray(incoming.length - this.maximumBytes),
      );
      return;
    }
    const combined = Buffer.concat([this.value, incoming]);
    this.value = combined.length <= this.maximumBytes
      ? combined
      : Buffer.from(combined.subarray(combined.length - this.maximumBytes));
  }

  text(): string | undefined {
    if (this.value.length === 0) return undefined;
    const value = sanitizeDiagnosticText(
      this.value.toString("utf8"),
      this.maximumBytes,
    ).trim();
    return value === "" ? undefined : value;
  }
}

function sanitizeDiagnosticText(value: string, maximum: number): string {
  const safe = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replace(/\r\n?/gu, "\n");
  return truncate(safe, maximum);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
