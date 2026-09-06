import { createHash, randomUUID } from "node:crypto";
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
  McpCatalogError,
  McpStaleToolError,
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
  McpServerCatalog,
  McpServerOptions,
  McpToolOutput,
  OpenMcpClientPoolOptions,
} from "./types.js";

const DEFAULT_CLIENT_INFO = { name: "may-mcp-client", version: "0.1.0" };
const DEFAULT_STDERR_MAX_BYTES = 16 * 1_024;

class McpConnection {
  private closed = false;
  generation = randomUUID();
  private readonly installedTools = new Map<string, string>();
  private stale = true;
  catalogSubscription: NonNullable<McpServerStatus["catalogSubscription"]> = "not-advertised";
  private activeCalls = 0;
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
    onCatalogChanged: () => void,
  ): Promise<McpConnection> {
    validateMcpServerOptions(options);
    const client = new Client(poolOptions.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {},
      listMaxPages: 64,
      // Each connection owns a separate cache, including after reconnect/login.
      listChanged: Object.fromEntries(["tools", "resources", "prompts"].map((kind) => [kind, {
        autoRefresh: false, debounceMs: 0, onChanged: onCatalogChanged,
      }])),
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
      const advertised = client.getServerCapabilities();
      const expected = {
        toolsListChanged: advertised?.tools?.listChanged,
        resourcesListChanged: advertised?.resources?.listChanged,
        promptsListChanged: advertised?.prompts?.listChanged,
      };
      if (Object.values(expected).some(Boolean)) {
        if (client.getProtocolEra() === "legacy") connection.catalogSubscription = "legacy";
        else {
          const subscription = client.autoOpenedSubscription;
          connection.catalogSubscription = subscription === undefined ? "unavailable" :
            Object.entries(expected).every(([key, value]) => !value || subscription.honoredFilter[key as keyof typeof expected]) ? "active" : "partial";
          void subscription?.closed.then(() => {
            connection.catalogSubscription = "unavailable";
            if (!connection.closed && !connection.closing) {
              connection.invalidate();
              onAvailability(new McpCatalogError(options.id, "catalog subscription ended; refresh or reconnect explicitly"));
            }
          });
        }
      }
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

  invalidate(): void { this.stale = true; }

  get busy(): boolean { return this.activeCalls > 0; }

  install(definitions: readonly ProtocolTool[]): readonly Tool[] {
    const tools = createTools(this, definitions);
    this.installedTools.clear();
    for (const definition of definitions) this.installedTools.set(definition.name, fingerprint(definition));
    this.stale = false;
    return tools;
  }

  async discover(signal?: AbortSignal): Promise<Omit<McpServerCatalog, "revision" | "serverId">> {
    this.throwIfClosed();
    const span = startTraceSpan(this.tracer, "may.mcp.tools.list", { attributes: this.traceAttributes });
    try {
      const capabilities = this.client.getServerCapabilities() ?? {};
      const options = requestOptions(this.options, signal);
      // Explicit page walking rejects repeated cursors rather than publishing a partial catalog.
      const tools = capabilities.tools === undefined ? [] : await listAll(this.options.id, async (cursor) => {
        const result = await this.client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, options);
        return { items: result.tools, nextCursor: result.nextCursor };
      });
      const resources = capabilities.resources === undefined ? [] : await listAll(this.options.id, async (cursor) => {
        const result = await this.client.request({ method: "resources/list", params: cursor === undefined ? {} : { cursor } }, options);
        return { items: result.resources, nextCursor: result.nextCursor };
      });
      const resourceTemplates = capabilities.resources === undefined ? [] : await listAll(this.options.id, async (cursor) => {
        const result = await this.client.request({ method: "resources/templates/list", params: cursor === undefined ? {} : { cursor } }, options);
        return { items: result.resourceTemplates, nextCursor: result.nextCursor };
      });
      const prompts = capabilities.prompts === undefined ? [] : await listAll(this.options.id, async (cursor) => {
        const result = await this.client.request({ method: "prompts/list", params: cursor === undefined ? {} : { cursor } }, options);
        return { items: result.prompts, nextCursor: result.nextCursor };
      });
      const catalog = { capabilities, tools, resources, resourceTemplates, prompts };
      if (tools.length + resources.length + resourceTemplates.length + prompts.length > 4096 ||
          Buffer.byteLength(JSON.stringify(catalog)) > 8 * 1024 * 1024) {
        throw new McpCatalogError(this.options.id, "catalog exceeds host limits");
      }
      assertUnique(tools.map((tool) => namespaceMcpToolName(this.options.id, tool.name)), this.options.id);
      assertUnique(resources.map((resource) => resource.uri), this.options.id);
      assertUnique(resourceTemplates.map((template) => template.uriTemplate), this.options.id);
      assertUnique(prompts.map((prompt) => prompt.name), this.options.id);
      endTraceSpan(span, { status: "ok", attributes: { "may.mcp.tools.count": tools.length } });
      return freezeTree(structuredClone(catalog));
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, signal);
      if (signal?.aborted === true) throw error;
      if (error instanceof McpCatalogError) throw error;
      if (safeError instanceof McpAuthenticationError || safeError instanceof McpCredentialStoreError) throw safeError;
      const recentStderr = this.stderr.text();
      throw new McpToolsListError(this.options.id, sanitizeDiagnosticText(errorMessage(safeError), 2_000), {
        ...(recentStderr === undefined ? {} : { stderr: recentStderr }),
      });
    }
  }

  async callTool(
    definition: ProtocolTool,
    exposedName: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
    generation: string,
  ): Promise<McpToolOutput> {
    this.throwIfClosed();
    context.signal.throwIfAborted();
    if (generation !== this.generation || this.stale || this.installedTools.get(definition.name) !== fingerprint(definition)) {
      throw new McpStaleToolError(this.options.id);
    }
    this.activeCalls++;
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
    } finally {
      this.activeCalls--;
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
  catalogStale?: boolean;
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

  catalogUpdated(server: McpServerOptions, revision: number, toolNames: readonly string[]): void {
    this.queue.push({ type: "mcp.server.catalog-updated", seq: ++this.sequence, timestamp: Date.now(),
      serverId: server.id, transport: server.transport ?? "stdio", required: server.required !== false,
      revision, toolNames: [...toolNames] });
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

interface PoolEntry {
  readonly server: McpServerOptions;
  readonly status: MutableMcpServerStatus;
  connection?: McpConnection;
  catalog?: McpServerCatalog;
  tools: readonly Tool[];
  invalidations: number;
  chain: Promise<void>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshScheduled?: boolean;
}

class DefaultMcpClientPool implements McpClientPool {
  readonly events: AsyncIterable<McpClientEvent>;
  private readonly entries: PoolEntry[];
  private readonly lifetime = new AbortController();
  private readonly recorder = new McpEventRecorder();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: OpenMcpClientPoolOptions) {
    this.events = this.recorder.events;
    this.entries = options.servers.map((server) => ({
      server, tools: [], invalidations: 0, chain: Promise.resolve(),
      status: { serverId: server.id, transport: server.transport ?? "stdio",
        required: server.required !== false, state: "failed", toolNames: [] },
    }));
  }

  get tools(): readonly Tool[] {
    if (this.closed) return Object.freeze([]);
    return Object.freeze(this.entries.filter((entry) => entry.status.state === "connected" && entry.status.catalogStale !== true)
      .flatMap((entry) => entry.tools));
  }

  catalog(): readonly McpServerCatalog[] {
    return Object.freeze(this.entries.flatMap((entry) => entry.catalog === undefined ? [] : [entry.catalog]));
  }

  status(): readonly McpServerStatus[] {
    return this.entries.map(({ status, connection, catalog }) => {
      const stderr = connection?.stderrText() ?? status.diagnostic?.stderr;
      return { ...status,
        ...(connection === undefined ? {} : { catalogSubscription: connection.catalogSubscription }),
        toolNames: [...status.toolNames],
        ...(catalog === undefined ? {} : { catalogRevision: catalog.revision }),
        ...(stderr === undefined ? {} : { stderr }),
        ...(status.diagnostic === undefined ? {} : { diagnostic: { ...status.diagnostic } }),
      };
    });
  }

  async initialize(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await this.connect(entry, this.signal(this.options.signal));
      } catch (error) {
        if (this.options.signal?.aborted === true || entry.server.required !== false) {
          await this.close().catch(() => {});
          throw error;
        }
      }
    }
  }

  async refresh(serverId?: string, signal?: AbortSignal): Promise<void> {
    const entries = serverId === undefined ? this.entries : [this.entry(serverId)];
    for (const entry of entries) {
      await this.enqueue(entry, () => this.refreshEntry(entry, this.signal(signal)));
    }
  }

  reconnect(serverId: string, signal?: AbortSignal): Promise<void> {
    const entry = this.entry(serverId);
    return this.enqueue(entry, async () => {
      this.signal(signal).throwIfAborted();
      if (entry.connection?.busy) throw new McpCatalogError(serverId, "cannot reconnect during an active operation");
      entry.connection?.invalidate();
      const previous = entry.connection;
      delete entry.connection;
      await closeConnectionQuietly(previous);
      await this.connect(entry, this.signal(signal));
    });
  }

  close(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    this.closed = true;
    this.lifetime.abort("MCP pool is closing");
    for (const entry of this.entries) clearTimeout(entry.refreshTimer);
    await Promise.allSettled(this.entries.map((entry) => entry.chain));
    const failures: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.connection === undefined) continue;
      try {
        await entry.connection.close();
        entry.status.state = "disconnected";
        this.recorder.disconnected(entry.server);
      } catch (error) { failures.push(error); this.fail(entry, error); }
    }
    this.recorder.close();
    if (failures.length > 0) throw new AggregateError(failures, "One or more MCP clients failed to close");
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
  }

  private entry(serverId: string): PoolEntry {
    const entry = this.entries.find((entry) => entry.server.id === serverId);
    if (entry === undefined) throw new McpConfigurationError(`Unknown MCP server: ${serverId}`);
    return entry;
  }

  private enqueue(entry: PoolEntry, work: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new McpClientPoolClosedError());
    const promise = entry.chain.then(() => { this.lifetime.signal.throwIfAborted(); return work(); });
    entry.chain = promise.catch(() => {});
    return promise;
  }

  private async connect(entry: PoolEntry, signal: AbortSignal): Promise<void> {
    let connection: McpConnection | undefined;
    try {
      connection = await McpConnection.open(entry.server, { ...this.options, signal }, (error) => {
        if (entry.connection !== connection || this.closed) return;
        if (error !== undefined) this.fail(entry, error);
      }, () => {
        if (this.closed || (connection !== undefined && entry.connection !== connection)) return;
        entry.invalidations++;
        connection?.invalidate();
        entry.status.catalogStale = true;
        if (entry.connection === connection && connection !== undefined) this.scheduleRefresh(entry);
      });
      entry.connection = connection;
      const version = connection.protocolVersion();
      if (version !== undefined) entry.status.protocolVersion = version;
      await this.refreshEntry(entry, signal, true);
      this.recorder.connected(entry.server, entry.status.toolNames);
    } catch (error) {
      if (entry.connection === connection) delete entry.connection;
      await closeConnectionQuietly(connection);
      entry.tools = [];
      entry.status.toolNames = [];
      this.fail(entry, error);
      throw error;
    }
  }

  private scheduleRefresh(entry: PoolEntry): void {
    if (this.closed || entry.refreshScheduled === true) return;
    entry.refreshScheduled = true;
    entry.refreshTimer = setTimeout(() => {
      delete entry.refreshTimer;
      void this.enqueue(entry, () => this.refreshEntry(entry, this.lifetime.signal)).catch(() => {}).finally(() => { entry.refreshScheduled = false; });
    }, 50);
  }

  private async refreshEntry(entry: PoolEntry, signal: AbortSignal, initial = false): Promise<void> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(entry.server.maxTotalTimeoutMs ?? 60_000)]);
    const connection = entry.connection;
    if (connection === undefined) throw new McpCatalogError(entry.server.id, "endpoint is unavailable; reconnect explicitly");
    try {
      // Retry discovery only, not tools; bound an invalidation storm.
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const stamp = entry.invalidations;
        const candidate = await connection.discover(signal);
        signal.throwIfAborted();
        if (stamp !== entry.invalidations) continue;
        const otherNames = new Set(this.entries.filter((other) => other !== entry).flatMap((other) => other.tools.map((tool) => tool.name)));
        if (!initial && (entry.status.state === "auth-required" || entry.status.state === "failed")) connection.generation = randomUUID();
        const tools = connection.install(candidate.tools);
        if (tools.some((tool) => otherNames.has(tool.name))) throw new McpCatalogError(entry.server.id, "tool namespace collision");
        const changed = entry.catalog === undefined || fingerprint(candidate) !== fingerprint({
          capabilities: entry.catalog.capabilities, tools: entry.catalog.tools,
          resources: entry.catalog.resources, resourceTemplates: entry.catalog.resourceTemplates, prompts: entry.catalog.prompts,
        });
        const revision = (entry.catalog?.revision ?? 0) + (changed || initial ? 1 : 0);
        entry.catalog = freezeTree({ ...candidate, serverId: entry.server.id, revision });
        entry.tools = tools;
        entry.status.toolNames = tools.map((tool) => tool.name);
        entry.status.state = "connected";
        entry.status.catalogStale = false;
        delete entry.status.diagnostic;
        if (!initial && changed) this.recorder.catalogUpdated(entry.server, revision, entry.status.toolNames);
        return;
      }
      throw new McpCatalogError(entry.server.id, "catalog changed repeatedly during discovery; refresh again");
    } catch (error) {
      connection.invalidate();
      entry.status.catalogStale = true;
      if (!initial) this.fail(entry, error);
      throw error;
    }
  }

  private fail(entry: PoolEntry, error: unknown): void {
    entry.connection?.invalidate();
    entry.status.catalogStale = true;
    entry.status.state = error instanceof McpAuthenticationError && error.code === "MCP_AUTHENTICATION_REQUIRED" ? "auth-required" : "failed";
    entry.status.diagnostic = toDiagnostic(error);
    this.recorder.failed(entry.server, entry.status.diagnostic);
  }
}

export async function openMcpClientPool(options: OpenMcpClientPoolOptions): Promise<McpClientPool> {
  const serverIds = new Set<string>();
  for (const server of options.servers) {
    validateMcpServerOptions(server);
    if (serverIds.has(server.id)) throw new McpConfigurationError(`Duplicate MCP server id: ${server.id}`);
    serverIds.add(server.id);
  }
  // Configuration and its account/endpoint identity must not change underneath an open pool.
  const pool = new DefaultMcpClientPool({ ...options, servers: freezeTree(structuredClone(options.servers)) });
  await pool.initialize();
  return pool;
}

function createTools(
  connection: McpConnection,
  definitions: readonly ProtocolTool[],
): readonly Tool[] {
  return definitions.map((original) => {
    const definition = freezeTree(structuredClone(original));
    const generation = connection.generation;
    const exposedName = namespaceMcpToolName(
      connection.options.id,
      definition.name,
    );
    return Object.freeze({
      name: exposedName,
      permissionVersion: fingerprint([connection.options, generation, definition]),
      description: `[MCP server: ${connection.options.id}] ${
        definition.description ?? definition.name
      }`,
      inputSchema: definition.inputSchema as JsonSchema,
      parse: (input: unknown) => parseArguments(exposedName, input),
      execute: (input: Record<string, unknown>, context: ToolExecutionContext) =>
        connection.callTool(definition, exposedName, input, context, generation),
    });
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  })).digest("hex");
}

function freezeTree<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function assertUnique(values: readonly string[], serverId: string): void {
  if (new Set(values).size !== values.length) throw new McpCatalogError(serverId, "duplicate catalog identity");
}

async function listAll<T>(serverId: string, page: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor: string | undefined }>): Promise<T[]> {
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
