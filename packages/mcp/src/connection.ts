import { openConnectionApp } from "./connection-apps.js";
import { listMcpCatalog } from "./connection-catalog.js";
import { createTools, describeToolError, formatProgress } from "./connection-tools.js";
import { randomUUID } from "node:crypto";
import {
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Client,
  type RequestOptions,
  type Tool as ProtocolTool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  endTraceSpan,
  omitUndefined,
  startTraceSpan,
  traceError,
  type Tool,
  type ToolExecutionContext,
  type TraceAttributes,
  type Tracer,
} from "@sortedyuan/may/core";

import {
  McpCatalogError,
  McpCapabilityError,
  McpContentError,
  McpStaleToolError,
  McpConnectionError,
  McpToolCallError,
  McpToolReportedError,
  McpToolsListError,
} from "./errors.js";
import {
  McpAppSession,
  MCP_APPS_EXTENSION,
  MCP_APP_MIME,
  mcpToolVisibility,
  mcpAppUri,
  appError,
  type McpAppOpenOptions,
} from "./apps.js";
import { McpCapabilities } from "./capabilities.js";
import { McpHostClient, mcpOwner } from "./host-client.js";
import { hostCapabilities, hostFailure } from "./host-services.js";
import { McpTaskRuntime, type McpTaskWaitOptions, type McpTaskUpdateOptions } from "./task-runtime.js";
import { MCP_TASKS_EXTENSION, taskFailure } from "./tasks.js";
import type { McpInteractionOwner } from "./interactions.js";
import { assertMcpContentSize, mcpToolResultContent } from "./content.js";
import { McpAuthenticationError } from "./oauth.js";
import { McpCredentialStoreError } from "./credentials.js";
import { createMcpTransport, safeMcpTransportError, validateMcpServerOptions } from "./transports.js";
import { BoundedStderrBuffer, errorMessage, requestOptions, sanitizeDiagnosticText } from "./transport-support.js";
import { fingerprint, freezeTree } from "./value-support.js";
import type {
  McpOperationOptions,
  McpServerStatus,
  McpServerCatalog,
  McpServerOptions,
  McpToolOutput,
  OpenMcpClientPoolOptions,
} from "./types.js";

const DEFAULT_CLIENT_INFO = { name: "may-mcp-client", version: "0.1.0" };
const DEFAULT_STDERR_MAX_BYTES = 16 * 1_024;

export class McpConnection {
  private closed = false;
  readonly capabilities: McpCapabilities;
  private readonly lifetime = new AbortController();
  private authorizationIdentity: string | undefined;
  private authorizeIdentity: (() => Promise<string>) | undefined;
  generation = randomUUID();
  private readonly installedTools = new Map<string, string>();
  private stale = true;
  catalogSubscription: NonNullable<McpServerStatus["catalogSubscription"]> = "not-advertised";
  private activeCalls = 0;
  private closing = false;
  private connected = false;
  private lastTransportError: Error | undefined;
  private catalog: McpServerCatalog | undefined;
  private isolatedLegacy = false;
  private parentGuard: (() => Promise<void>) | undefined;
  private readonly legacyOperations = new Set<Promise<unknown>>();
  private taskRuntime: McpTaskRuntime | undefined;
  private readonly taskOperations = new Set<Promise<unknown>>();
  private appOpening = 0;
  private readonly appSessions = new Set<McpAppSession>();
  private closeResult: Promise<void> | undefined;
  private readonly background = new Set<Promise<void>>();
  private backgroundFailure: Error | undefined;

  private constructor(
    readonly options: McpServerOptions,
    private readonly client: McpHostClient,
    private readonly transport: ReturnType<typeof createMcpTransport>,
    private readonly stderr: BoundedStderrBuffer,
    private readonly tracer: Tracer | undefined,
    private readonly traceAttributes: TraceAttributes,
    private readonly onAvailability: (error?: Error) => void,
    private readonly poolOptions: OpenMcpClientPoolOptions,
  ) {
    this.capabilities = new McpCapabilities(client, options, (method, options, work) =>
      this.runCapability(method, options, work),
    );
    if (options.tasks && poolOptions.taskJournal !== undefined)
      this.taskRuntime = new McpTaskRuntime(options.id, client, poolOptions.taskJournal, async (name) => {
        this.throwIfClosed();
        await this.checkAuthorization();
        const definition = this.catalog?.tools.find((tool) => tool.name === name);
        if (this.stale || definition === undefined) throw new McpStaleToolError(options.id);
        const destination =
          options.transport === "streamable-http"
            ? [
                "streamable-http",
                new URL(options.url).href,
                Object.entries(options.headers ?? {})
                  .map(([name, value]) => [name.toLowerCase(), value])
                  .sort(),
                this.authorizationIdentity,
              ]
            : ["stdio", options.command, options.args, options.cwd, options.env];
        return {
          definition,
          binding: {
            serverId: options.id,
            protocolVersion: "2026-07-28",
            endpointIdentity: fingerprint(destination),
            toolName: name,
            toolDefinitionHash: fingerprint(definition),
          },
        };
      });
  }

  static async open(
    options: McpServerOptions,
    poolOptions: OpenMcpClientPoolOptions,
    onAvailability: (error?: Error) => void,
    onCatalogChanged: () => void,
  ): Promise<McpConnection> {
    validateMcpServerOptions(options);
    const client = new McpHostClient(poolOptions.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {
        ...hostCapabilities(options.host, poolOptions.interactions, poolOptions.hostServices),
        ...(poolOptions.apps === undefined
          ? {}
          : { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } }),
      },
      inputRequired: { autoFulfill: true, maxRounds: 8 },
      listMaxPages: 64,
      // Each connection owns a separate cache, including after reconnect/login.
      listChanged: Object.fromEntries(
        ["tools", "resources", "prompts"].map((kind) => [
          kind,
          {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: onCatalogChanged,
          },
        ]),
      ),
      versionNegotiation: {
        mode: options.protocolMode ?? (options.transport === "streamable-http" ? "auto" : "legacy"),
        probe: {
          timeoutMs: Math.min(options.requestTimeoutMs ?? 60_000, options.maxTotalTimeoutMs ?? Infinity),
          maxRetries: 0,
        },
      },
    });
    client.configureHost(options.id, poolOptions.interactions, options.host, poolOptions.hostServices);
    const stderr = new BoundedStderrBuffer(
      options.transport === "streamable-http" ? 0 : (options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES),
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
      poolOptions,
    );
    client.onerror = (error) => {
      connection.lastTransportError = safeMcpTransportError(error, options) as Error;
    };
    client.onclose = () => connection.handleClose();

    // SDK discovery precedes Protocol request registration. Close the raw
    // transport on cancellation so both HTTP probes and stdio siblings stop.
    let cancelledTransport: Promise<PromiseSettledResult<void>[]> | undefined;
    const abortConnect = () => {
      cancelledTransport ??= Promise.allSettled([transport.close()]);
    };
    poolOptions.signal?.addEventListener("abort", abortConnect, { once: true });
    try {
      poolOptions.signal?.throwIfAborted();
      await client.connect(transport, requestOptions(options, poolOptions.signal));
      poolOptions.signal?.throwIfAborted();
      endTraceSpan(span, {
        status: "ok",
        ...(!(transport instanceof StdioClientTransport) || transport.pid === null
          ? {}
          : { attributes: { "process.pid": transport.pid } }),
      });
      if (options.transport === "streamable-http" && options.auth !== undefined) {
        connection.authorizeIdentity = () => poolOptions.oauth!.authorizationIdentity(options);
        connection.authorizationIdentity = await connection.authorizeIdentity();
      }
      connection.connected = true;
      const advertised = client.getServerCapabilities();
      if (
        options.tasks &&
        (client.getNegotiatedProtocolVersion() !== "2026-07-28" ||
          advertised?.extensions?.[MCP_TASKS_EXTENSION] === undefined)
      )
        throw taskFailure(options.id, "endpoint does not support the enabled 2026-07-28 Tasks extension");
      const expected = {
        toolsListChanged: advertised?.tools?.listChanged,
        resourcesListChanged: advertised?.resources?.listChanged,
        promptsListChanged: advertised?.prompts?.listChanged,
      };
      if (Object.values(expected).some(Boolean)) {
        if (client.getProtocolEra() === "legacy") connection.catalogSubscription = "legacy";
        else {
          const subscription = client.autoOpenedSubscription;
          connection.catalogSubscription =
            subscription === undefined
              ? "unavailable"
              : Object.entries(expected).every(
                    ([key, value]) => !value || subscription.honoredFilter[key as keyof typeof expected],
                  )
                ? "active"
                : "partial";
          if (subscription !== undefined)
            connection.own(
              subscription.closed.then(() => {
                connection.catalogSubscription = "unavailable";
                if (!connection.closed && !connection.closing) {
                  connection.invalidate();
                  onAvailability(
                    new McpCatalogError(options.id, "catalog subscription ended; refresh or reconnect explicitly"),
                  );
                }
              }),
            );
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
        omitUndefined({
          cause: safeError instanceof Error ? safeError : undefined,
          stderr: recentStderr,
        }),
      );
    } finally {
      poolOptions.signal?.removeEventListener("abort", abortConnect);
      const closed = await cancelledTransport;
      const failed = closed?.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  }

  invalidate(): void {
    for (const app of this.appSessions) app.close();
    this.stale = true;
    this.capabilities.invalidate();
  }

  updateCatalog(catalog: McpServerCatalog): void {
    this.catalog = catalog;
    this.capabilities.updateCatalog(catalog);
  }

  get busy(): boolean {
    return this.activeCalls > 0;
  }

  install(definitions: readonly ProtocolTool[]): readonly Tool[] {
    const tools = createTools(
      this,
      definitions.filter((tool) => mcpToolVisibility(tool, "model")),
    );
    this.installedTools.clear();
    for (const definition of definitions) this.installedTools.set(definition.name, fingerprint(definition));
    this.stale = false;
    return tools;
  }

  async discover(signal?: AbortSignal): Promise<Omit<McpServerCatalog, "revision" | "serverId">> {
    this.throwIfClosed();
    const span = startTraceSpan(this.tracer, "may.mcp.tools.list", { attributes: this.traceAttributes });
    try {
      await this.checkAuthorization();
      const catalog = await listMcpCatalog(this.client, this.options.id, requestOptions(this.options, signal));
      endTraceSpan(span, { status: "ok", attributes: { "may.mcp.tools.count": catalog.tools.length } });
      return freezeTree(structuredClone(catalog));
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, signal);
      if (signal?.aborted === true) throw error;
      if (error instanceof McpCatalogError) throw error;
      if (safeError instanceof McpAuthenticationError || safeError instanceof McpCredentialStoreError) throw safeError;
      const recentStderr = this.stderr.text();
      throw new McpToolsListError(
        this.options.id,
        sanitizeDiagnosticText(errorMessage(safeError), 2_000),
        omitUndefined({
          stderr: recentStderr,
        }),
      );
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
    if (
      generation !== this.generation ||
      this.stale ||
      this.installedTools.get(definition.name) !== fingerprint(definition)
    ) {
      throw new McpStaleToolError(this.options.id);
    }
    this.activeCalls++;
    const span = startTraceSpan(this.tracer, "may.mcp.tool.call", {
      ...omitUndefined({ parent: context.traceContext }),
      attributes: {
        ...this.traceAttributes,
        "may.step": context.step,
        "may.tool.name": exposedName,
        "may.tool.call_id": context.toolCallId,
        "may.mcp.tool.remote_name": definition.name,
      },
    });

    try {
      await this.checkAuthorization();
      context.signal.throwIfAborted();
      const request = {
        ...this.client.scope(
          requestOptions(this.options, context.signal),
          mcpOwner(context.scope, context.runId, context.toolCallId),
          this.lifetime.signal,
          async () => {
            await this.checkAuthorization();
            if (
              generation !== this.generation ||
              this.stale ||
              this.installedTools.get(definition.name) !== fingerprint(definition)
            )
              throw new McpStaleToolError(this.options.id);
          },
        ),
        resetTimeoutOnProgress: true,
        toolDefinition: definition,
        onprogress: (progress: Parameters<NonNullable<RequestOptions["onprogress"]>>[0]) =>
          context.report({ type: "progress", message: formatProgress(progress), data: progress }),
      };
      const result = await this.client.runScoped(
        request,
        () =>
          this.needsLegacyIsolation()
            ? this.withLegacyIsolation(request.signal!, (connection, signal) =>
                connection
                  .callTool(definition, exposedName, input, { ...context, signal }, connection.generation)
                  // The child has already validated the SDK result and thrown any tool error.
                  .then((output) => ({ ...output, content: [...output.content] }) as CallToolResult),
              )
            : this.taskRuntime === undefined
              ? this.client.callTool({ name: definition.name, arguments: input }, request)
              : this.trackTask(() =>
                  this.taskRuntime!.start(
                    definition,
                    input,
                    this.taskOwner(mcpOwner(context.scope, context.runId, context.toolCallId)),
                    request,
                  ),
                ),
        this.isolatedLegacy,
      );
      context.signal.throwIfAborted();
      await this.checkAuthorization();
      assertMcpContentSize(result);
      mcpToolResultContent(this.options.id, definition.name, result);
      if (result.isError === true) {
        throw new McpToolReportedError(this.options.id, definition.name, describeToolError(result));
      }

      this.onAvailability();
      endTraceSpan(span, { status: "ok" });
      return omitUndefined({
        content: result.content,
        _meta: result._meta,
        structuredContent: result.structuredContent,
      });
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, context.signal);
      if (
        context.signal.aborted ||
        error instanceof McpToolReportedError ||
        error instanceof McpContentError ||
        error instanceof McpCapabilityError
      ) {
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

  private async checkAuthorization(): Promise<void> {
    await this.parentGuard?.();
    if (this.authorizeIdentity === undefined) return;
    try {
      if ((await this.authorizeIdentity()) !== this.authorizationIdentity) {
        throw new McpCapabilityError(
          this.options.id,
          "authentication identity changed; reconnect before further operations",
        );
      }
    } catch (error) {
      this.invalidate();
      this.onAvailability(error as Error);
      throw error;
    }
  }

  private needsLegacyIsolation(): boolean {
    return (
      !this.isolatedLegacy &&
      this.poolOptions.interactions !== undefined &&
      this.options.host?.legacyRequests === "isolated" &&
      this.client.getProtocolEra() === "legacy"
    );
  }

  private withLegacyIsolation<T>(
    signal: AbortSignal,
    work: (connection: McpConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.legacyOperations.size >= 8)
      return Promise.reject(hostFailure(this.options.id, "legacy operation limit exceeded"));
    const operation = (async () => {
      const catalog = this.catalog;
      if (catalog === undefined) throw hostFailure(this.options.id, "missing legacy catalog");
      let isolated: McpConnection | undefined;
      let changes = 0;
      try {
        // A new client/session (and for stdio a new process) is created BEFORE
        // sending the user's operation. This is not replay or reconnect-on-error.
        isolated = await McpConnection.open(
          { ...this.options, protocolMode: "legacy" },
          { ...this.poolOptions, signal },
          () => {},
          () => {
            changes++;
            isolated?.invalidate();
          },
        );
        isolated.isolatedLegacy = true;
        isolated.parentGuard = async () => {
          signal.throwIfAborted();
          await this.checkAuthorization();
          if (this.stale || this.catalog === undefined || fingerprint(this.catalog) !== fingerprint(catalog))
            throw new McpStaleToolError(this.options.id);
        };
        const stamp = changes;
        const candidate = await isolated.discover(signal);
        const { serverId: _id, revision: _revision, ...expected } = catalog;
        if (
          changes !== stamp ||
          isolated.protocolVersion() !== this.protocolVersion() ||
          fingerprint(candidate) !== fingerprint(expected)
        )
          throw hostFailure(this.options.id, "isolated legacy catalog differs; refresh before using it");
        isolated.install(candidate.tools);
        isolated.updateCatalog({ ...candidate, serverId: this.options.id, revision: catalog.revision });
        await isolated.parentGuard();
        return await work(isolated, signal);
      } finally {
        await isolated?.close();
      }
    })();
    this.legacyOperations.add(operation);
    return operation.finally(() => {
      this.legacyOperations.delete(operation);
    });
  }

  private async runCapability<T>(
    method: string,
    options: McpOperationOptions,
    work: (request: RequestOptions, client: Client) => Promise<T>,
    wholeTimeoutMs?: number,
  ): Promise<T> {
    this.throwIfClosed();
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    signal.throwIfAborted();
    if (this.stale)
      throw new McpCapabilityError(this.options.id, "catalog is stale; refresh or reconnect before using capabilities");
    this.activeCalls++;
    const span = startTraceSpan(
      this.tracer,
      `may.mcp.${method.replaceAll("/", ".")}`,
      omitUndefined({
        attributes: this.traceAttributes,
        parent: options.traceContext,
      }),
    );
    try {
      await this.checkAuthorization();
      signal.throwIfAborted();
      const request = this.client.scope(
        { ...requestOptions(this.options, signal), ...omitUndefined({ maxTotalTimeout: wholeTimeoutMs }) },
        options.owner,
        this.lifetime.signal,
        async () => {
          await this.checkAuthorization();
          if (this.stale)
            throw new McpCapabilityError(this.options.id, "catalog changed during interaction; start a new operation");
        },
      );
      const result = await this.client.runScoped(
        request,
        () =>
          this.needsLegacyIsolation() && ["resources/read", "prompts/get"].includes(method)
            ? this.withLegacyIsolation(request.signal!, (connection, signal) =>
                connection.runCapability(method, { ...options, signal }, work),
              )
            : work(request, this.client),
        this.isolatedLegacy,
      );
      signal.throwIfAborted();
      await this.checkAuthorization();
      endTraceSpan(span, { status: "ok" });
      return result;
    } catch (error) {
      const safe =
        error instanceof McpCapabilityError || error instanceof McpContentError
          ? error
          : safeMcpTransportError(error, this.options);
      endMcpSpan(span, safe, signal);
      if (signal.aborted) throw error;
      if (safe instanceof McpAuthenticationError || safe instanceof McpCredentialStoreError) this.onAvailability(safe);
      if (
        safe instanceof McpCapabilityError ||
        safe instanceof McpContentError ||
        safe instanceof McpAuthenticationError ||
        safe instanceof McpCredentialStoreError
      )
        throw safe;
      throw new McpCapabilityError(this.options.id, sanitizeDiagnosticText(errorMessage(safe), 2000));
    } finally {
      this.activeCalls--;
    }
  }

  openApp(name: string, options: McpAppOpenOptions): Promise<McpAppSession> {
    if (this.appOpening + this.appSessions.size >= 16) return Promise.reject(appError());
    this.appOpening++;
    return this.openAppOwned(name, options).finally(() => {
      this.appOpening--;
    });
  }

  private async openAppOwned(name: string, options: McpAppOpenOptions): Promise<McpAppSession> {
    const host = this.poolOptions.apps;
    const catalog = this.catalog;
    const tool = catalog?.tools.find((entry) => entry.name === name);
    const uri = tool === undefined ? undefined : mcpAppUri(tool);
    const owner = options.owner;
    const lifetimeMs = options.lifetimeMs ?? 600_000;
    if (
      host === undefined ||
      catalog === undefined ||
      tool === undefined ||
      uri === undefined ||
      !owner?.workspaceId ||
      !owner.sessionId ||
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 3_600_000 ||
      this.appSessions.size >= 16
    )
      throw appError();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(lifetimeMs),
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    const trustedOwner = freezeTree(structuredClone(owner));
    const generation = this.generation;
    const guard = async () => {
      signal.throwIfAborted();
      this.throwIfClosed();
      await this.checkAuthorization();
      if (this.stale || this.generation !== generation || this.catalog?.revision !== catalog.revision) throw appError();
    };
    return openConnectionApp({
      host,
      catalog,
      tool,
      uri,
      owner: trustedOwner,
      signal,
      serverId: this.options.id,
      capabilities: this.capabilities,
      guard,
      createTool: (definition) => createTools(this, [definition])[0]!,
      ownApp: (app) => {
        this.appSessions.add(app);
        app.signal.addEventListener("abort", () => this.appSessions.delete(app), { once: true });
      },
    });
  }

  taskOperation(
    action: "get" | "update" | "wait",
    id: string,
    options: McpOperationOptions & McpTaskWaitOptions & McpTaskUpdateOptions,
  ) {
    if (options.retryAbandonedInputs !== undefined && typeof options.retryAbandonedInputs !== "boolean")
      throw taskFailure(this.options.id, "invalid task input retry option");
    if (
      action === "wait" &&
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000)
    )
      throw taskFailure(this.options.id, "invalid local task wait budget");
    const runtime = this.requireTaskRuntime();
    const owner = this.taskOwner(options.owner);
    return this.trackTask(() =>
      this.runCapability(
        `tasks/${action}`,
        options,
        (request) =>
          action === "wait"
            ? runtime.wait(id, owner, request, options)
            : action === "update"
              ? runtime.update(id, owner, request, options)
              : runtime.get(id, owner, request),
        action === "wait" ? (options.timeoutMs ?? 300_000) : undefined,
      ),
    );
  }
  cancelTask(id: string, options: McpOperationOptions) {
    const runtime = this.requireTaskRuntime();
    const owner = this.taskOwner(options.owner);
    return this.trackTask(() =>
      this.runCapability("tasks/cancel", options, (request) => runtime.cancel(id, owner, request)),
    );
  }
  private trackTask<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.taskOperations.add(operation);
    return operation.finally(() => {
      this.taskOperations.delete(operation);
    });
  }
  private taskOwner(owner: McpInteractionOwner | undefined): McpInteractionOwner {
    if (!owner?.workspaceId || !owner.sessionId)
      throw taskFailure(this.options.id, "Tasks require a trusted workspace/Session owner");
    return owner;
  }
  private requireTaskRuntime(): McpTaskRuntime {
    if (this.taskRuntime === undefined) throw taskFailure(this.options.id, "Tasks are not enabled on this endpoint");
    return this.taskRuntime;
  }

  close(): Promise<void> {
    return (this.closeResult ??= this.closeOwned());
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    this.closed = true;
    this.lifetime.abort("MCP connection is closing");
    for (const app of this.appSessions) app.close();
    await Promise.allSettled(this.legacyOperations);
    await Promise.allSettled(this.taskOperations);
    const span = startTraceSpan(this.tracer, "may.mcp.disconnect", {
      attributes: this.traceAttributes,
    });
    try {
      const results = await Promise.allSettled([
        this.capabilities.close(),
        (async () => {
          try {
            if (this.transport instanceof StreamableHTTPClientTransport) await this.transport.terminateSession();
          } finally {
            await this.client.close();
          }
        })(),
      ]);
      await Promise.all(this.background);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
      endTraceSpan(span, { status: "ok" });
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError);
      const recentStderr = this.stderr.text();
      throw new McpConnectionError(
        this.options.id,
        `disconnect failed: ${errorMessage(safeError)}`,
        omitUndefined({
          cause: safeError instanceof Error ? safeError : undefined,
          stderr: recentStderr,
        }),
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
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
    if (this.closed) throw new McpConnectionError(this.options.id, "connection is closed; reconnect the server");
  }

  private handleClose(): void {
    if (this.closing || this.closed || !this.connected) return;
    this.closed = true;
    this.lifetime.abort("MCP connection closed");
    this.own(this.capabilities.close());
    const recentStderr = this.stderr.text();
    const cause = this.lastTransportError;
    this.onAvailability(
      new McpConnectionError(
        this.options.id,
        cause === undefined
          ? "connection closed unexpectedly"
          : `connection closed unexpectedly: ${sanitizeDiagnosticText(cause.message, 2_000)}`,
        omitUndefined({ cause, stderr: recentStderr }),
      ),
    );
  }

  private own(operation: Promise<unknown>): void {
    const task = operation.then(
      () => {
        this.background.delete(task);
      },
      (error: unknown) => {
        this.backgroundFailure ??= error instanceof Error ? error : new Error(String(error));
        this.background.delete(task);
      },
    );
    this.background.add(task);
  }
}

function endMcpSpan(span: ReturnType<typeof startTraceSpan>, error: unknown, signal?: AbortSignal): void {
  endTraceSpan(span, {
    status: signal?.aborted === true ? "cancelled" : "error",
    error: traceError(error),
  });
}

async function closeQuietly(client: McpHostClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Preserve the connection failure that caused cleanup.
  }
}

export async function closeConnectionQuietly(connection: McpConnection | undefined): Promise<void> {
  try {
    await connection?.close();
  } catch {
    // Preserve the startup failure that caused cleanup.
  }
}
