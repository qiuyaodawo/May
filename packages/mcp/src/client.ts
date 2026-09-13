import { waitForHost } from "./host-wait.js";
import { createHash, randomUUID } from "node:crypto";
import {
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Client,
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
  McpCapabilityError,
  McpContentError,
  McpStaleToolError,
  McpConfigurationError,
  McpConnectionError,
  McpToolCallError,
  McpToolReportedError,
  McpToolsListError,
} from "./errors.js";
import { McpAppSession, MCP_APPS_EXTENSION, MCP_APP_MIME, mcpToolVisibility, mcpAppUri, parseMcpAppResource, appError, type McpAppOpenOptions } from "./apps.js";
import { McpCapabilities } from "./capabilities.js";
import { McpHostClient, mcpOwner } from "./host-client.js";
import { hostCapabilities, hostFailure } from "./host-services.js";
import { McpTaskRuntime, type McpTaskWaitOptions, type McpTaskUpdateOptions } from "./task-runtime.js";
import { MCP_TASKS_EXTENSION, taskFailure } from "./tasks.js";
import type { McpInteractionOwner } from "./interactions.js";
import { assertMcpContentSize, mcpToolResultContent } from "./content.js";
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
  McpOperationOptions,
  McpReadOptions,
  McpCompletionParams,
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
    this.capabilities = new McpCapabilities(client, options, (method, options, work) => this.runCapability(method, options, work));
    if (options.tasks && poolOptions.taskJournal !== undefined) this.taskRuntime = new McpTaskRuntime(options.id, client, poolOptions.taskJournal, async (name) => {
      this.throwIfClosed(); await this.checkAuthorization();
      const definition = this.catalog?.tools.find((tool) => tool.name === name);
      if (this.stale || definition === undefined) throw new McpStaleToolError(options.id);
      const destination = options.transport === "streamable-http"
        ? ["streamable-http", new URL(options.url).href, Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).sort(), this.authorizationIdentity]
        : ["stdio", options.command, options.args, options.cwd, options.env];
      return { definition, binding: { serverId: options.id, protocolVersion: "2026-07-28", endpointIdentity: fingerprint(destination), toolName: name, toolDefinitionHash: fingerprint(definition) } };
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
      capabilities: { ...hostCapabilities(options.host, poolOptions.interactions, poolOptions.hostServices),
        ...(poolOptions.apps === undefined ? {} : { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } }),
      },
      inputRequired: { autoFulfill: true, maxRounds: 8 },
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
    client.configureHost(options.id, poolOptions.interactions, options.host, poolOptions.hostServices);
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
      poolOptions,
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
      if (options.transport === "streamable-http" && options.auth !== undefined) {
        connection.authorizeIdentity = () => poolOptions.oauth!.authorizationIdentity(options);
        connection.authorizationIdentity = await connection.authorizeIdentity();
      }
      connection.connected = true;
      const advertised = client.getServerCapabilities();
      if (options.tasks && (client.getNegotiatedProtocolVersion() !== "2026-07-28" || advertised?.extensions?.[MCP_TASKS_EXTENSION] === undefined)) throw taskFailure(options.id, "endpoint does not support the enabled 2026-07-28 Tasks extension");
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

  invalidate(): void { for (const app of this.appSessions) app.close(); this.stale = true; this.capabilities.invalidate(); }

  updateCatalog(catalog: McpServerCatalog): void { this.catalog = catalog; this.capabilities.updateCatalog(catalog); }

  get busy(): boolean { return this.activeCalls > 0; }

  install(definitions: readonly ProtocolTool[]): readonly Tool[] {
    const tools = createTools(this, definitions.filter((tool) => mcpToolVisibility(tool, "model")));
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
      await this.checkAuthorization();
      context.signal.throwIfAborted();
      const request = {
        ...this.client.scope(requestOptions(this.options, context.signal), mcpOwner(context.scope, context.runId, context.toolCallId), this.lifetime.signal, async () => {
          await this.checkAuthorization();
          if (generation !== this.generation || this.stale || this.installedTools.get(definition.name) !== fingerprint(definition)) throw new McpStaleToolError(this.options.id);
        }),
        resetTimeoutOnProgress: true,
        toolDefinition: definition,
        onprogress: (progress: Parameters<NonNullable<RequestOptions["onprogress"]>>[0]) => context.report({ type: "progress", message: formatProgress(progress), data: progress }),
      };
      const result = await this.client.runScoped(request, () => this.needsLegacyIsolation()
        ? this.withLegacyIsolation(request.signal!, (connection, signal) => connection.callTool(definition, exposedName, input, { ...context, signal }, connection.generation)
          // The child has already validated the SDK result and thrown any tool error.
          .then((output) => ({ ...output, content: [...output.content] }) as CallToolResult))
        : this.taskRuntime === undefined ? this.client.callTool({ name: definition.name, arguments: input }, request)
        : this.trackTask(() => this.taskRuntime!.start(definition, input, this.taskOwner(mcpOwner(context.scope, context.runId, context.toolCallId)), request)), this.isolatedLegacy);
      context.signal.throwIfAborted();
      await this.checkAuthorization();
      assertMcpContentSize(result);
      mcpToolResultContent(this.options.id, definition.name, result);
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
        ...(result._meta === undefined ? {} : { _meta: result._meta }),
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      };
    } catch (error) {
      const safeError = safeMcpTransportError(error, this.options);
      endMcpSpan(span, safeError, context.signal);
      if (context.signal.aborted || error instanceof McpToolReportedError || error instanceof McpContentError || error instanceof McpCapabilityError) {
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
      if (await this.authorizeIdentity() !== this.authorizationIdentity) {
        throw new McpCapabilityError(this.options.id, "authentication identity changed; reconnect before further operations");
      }
    } catch (error) { this.invalidate(); this.onAvailability(error as Error); throw error; }
  }

  private needsLegacyIsolation(): boolean {
    return !this.isolatedLegacy && this.poolOptions.interactions !== undefined &&
      this.options.host?.legacyRequests === "isolated" && this.client.getProtocolEra() === "legacy";
  }

  private withLegacyIsolation<T>(signal: AbortSignal, work: (connection: McpConnection, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.legacyOperations.size >= 8) return Promise.reject(hostFailure(this.options.id, "legacy operation limit exceeded"));
    const operation = (async () => {
      const catalog = this.catalog;
      if (catalog === undefined) throw hostFailure(this.options.id, "missing legacy catalog");
      let isolated: McpConnection | undefined;
      let changes = 0;
      try {
        // A new client/session (and for stdio a new process) is created BEFORE
        // sending the user's operation. This is not replay or reconnect-on-error.
        isolated = await McpConnection.open({ ...this.options, protocolMode: "legacy" }, { ...this.poolOptions, signal }, () => {}, () => { changes++; isolated?.invalidate(); });
        isolated.isolatedLegacy = true;
        isolated.parentGuard = async () => {
          signal.throwIfAborted();
          await this.checkAuthorization();
          if (this.stale || this.catalog === undefined || fingerprint(this.catalog) !== fingerprint(catalog)) throw new McpStaleToolError(this.options.id);
        };
        const stamp = changes;
        const candidate = await isolated.discover(signal);
        const { serverId: _id, revision: _revision, ...expected } = catalog;
        if (changes !== stamp || isolated.protocolVersion() !== this.protocolVersion() || fingerprint(candidate) !== fingerprint(expected)) throw hostFailure(this.options.id, "isolated legacy catalog differs; refresh before using it");
        isolated.install(candidate.tools);
        isolated.updateCatalog({ ...candidate, serverId: this.options.id, revision: catalog.revision });
        await isolated.parentGuard();
        return await work(isolated, signal);
      } finally { await isolated?.close().catch(() => undefined); }
    })();
    this.legacyOperations.add(operation);
    void operation.then(() => this.legacyOperations.delete(operation), () => this.legacyOperations.delete(operation));
    return operation;
  }

  private async runCapability<T>(method: string, options: McpOperationOptions, work: (request: RequestOptions, client: Client) => Promise<T>, wholeTimeoutMs?: number): Promise<T> {
    this.throwIfClosed();
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    signal.throwIfAborted();
    if (this.stale) throw new McpCapabilityError(this.options.id, "catalog is stale; refresh or reconnect before using capabilities");
    this.activeCalls++;
    const span = startTraceSpan(this.tracer, `may.mcp.${method.replaceAll("/", ".")}`, {
      attributes: this.traceAttributes, ...(options.traceContext === undefined ? {} : { parent: options.traceContext }),
    });
    try {
      await this.checkAuthorization();
      signal.throwIfAborted();
      const request = this.client.scope({ ...requestOptions(this.options, signal), ...(wholeTimeoutMs === undefined ? {} : { maxTotalTimeout: wholeTimeoutMs }) }, options.owner, this.lifetime.signal, async () => {
        await this.checkAuthorization();
        if (this.stale) throw new McpCapabilityError(this.options.id, "catalog changed during interaction; start a new operation");
      });
      const result = await this.client.runScoped(request, () => this.needsLegacyIsolation() && ["resources/read", "prompts/get"].includes(method)
        ? this.withLegacyIsolation(request.signal!, (connection, signal) => connection.runCapability(method, { ...options, signal }, work))
        : work(request, this.client), this.isolatedLegacy);
      signal.throwIfAborted();
      await this.checkAuthorization();
      endTraceSpan(span, { status: "ok" });
      return result;
    } catch (error) {
      const safe = error instanceof McpCapabilityError || error instanceof McpContentError ? error : safeMcpTransportError(error, this.options);
      endMcpSpan(span, safe, signal);
      if (signal.aborted) throw error;
      if (safe instanceof McpAuthenticationError || safe instanceof McpCredentialStoreError) this.onAvailability(safe);
      if (safe instanceof McpCapabilityError || safe instanceof McpContentError || safe instanceof McpAuthenticationError || safe instanceof McpCredentialStoreError) throw safe;
      throw new McpCapabilityError(this.options.id, sanitizeDiagnosticText(errorMessage(safe), 2000));
    } finally { this.activeCalls--; }
  }

  openApp(name: string, options: McpAppOpenOptions): Promise<McpAppSession> {
    if (this.appOpening + this.appSessions.size >= 16) return Promise.reject(appError());
    this.appOpening++;
    return this.openAppOwned(name, options).finally(() => { this.appOpening--; });
  }

  private async openAppOwned(name: string, options: McpAppOpenOptions): Promise<McpAppSession> {
    const host = this.poolOptions.apps;
    const catalog = this.catalog;
    const tool = catalog?.tools.find((entry) => entry.name === name);
    const uri = tool === undefined ? undefined : mcpAppUri(tool);
    const owner = options.owner;
    const lifetimeMs = options.lifetimeMs ?? 600_000;
    if (host === undefined || catalog === undefined || tool === undefined || uri === undefined ||
        !owner?.workspaceId || !owner.sessionId || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3_600_000 || this.appSessions.size >= 16) throw appError();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(lifetimeMs), ...(options.signal === undefined ? [] : [options.signal])]);
    const trustedOwner = freezeTree(structuredClone(owner));
    const generation = this.generation;
    const guard = async () => {
      signal.throwIfAborted(); this.throwIfClosed(); await this.checkAuthorization();
      if (this.stale || this.generation !== generation || this.catalog?.revision !== catalog.revision) throw appError();
    };
    const approve = async (kind: "open" | "read", target: string, currentSignal: AbortSignal) => {
      await guard(); currentSignal.throwIfAborted();
      if (await waitForHost(currentSignal, () => host.approve({ kind, serverId: this.options.id, uri: target, owner: trustedOwner, signal: currentSignal })) !== true) throw appError();
      await guard(); currentSignal.throwIfAborted();
    };
    await approve("open", uri, signal);
    const resource = parseMcpAppResource(uri, (await this.capabilities.readResource(uri, { owner: trustedOwner, signal, cache: "bypass" })).result);
    await guard();
    const app = new McpAppSession(resource, tool, { guard,
      call: async (name, input, currentSignal) => {
        await guard();
        const definition = catalog.tools.find((entry) => entry.name === name && mcpToolVisibility(entry, "app"));
        if (definition === undefined) throw appError();
        const adapted = createTools(this, [definition])[0]!;
        const operationId = randomUUID();
        const context: ToolExecutionContext = { scope: { workspaceId: trustedOwner.workspaceId, sessionId: trustedOwner.sessionId },
          runId: trustedOwner.runId ?? `mcp-app:${operationId}`, step: 0, toolCallId: operationId, idempotencyKey: operationId, signal: currentSignal, report() {} };
        const result = await waitForHost(currentSignal, () => host.executor.execute({ tool: adapted, input: adapted.parse?.(input) ?? input, context }));
        await guard(); return result as McpToolOutput;
      },
      read: async (target, currentSignal) => {
        if (target !== uri && !catalog.resources.some((entry) => entry.uri === target)) throw appError();
        await approve("read", target, currentSignal);
        const read = await this.capabilities.readResource(target, { owner: trustedOwner, signal: currentSignal, cache: "bypass" });
        await guard(); return read.result;
      },
    }, signal);
    this.appSessions.add(app);
    app.signal.addEventListener("abort", () => this.appSessions.delete(app), { once: true });
    return app;
  }

  taskOperation(action: "get" | "update" | "wait", id: string, options: McpOperationOptions & McpTaskWaitOptions & McpTaskUpdateOptions) {
    if (options.retryAbandonedInputs !== undefined && typeof options.retryAbandonedInputs !== "boolean") throw taskFailure(this.options.id, "invalid task input retry option");
    if (action === "wait" && options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000)) throw taskFailure(this.options.id, "invalid local task wait budget");
    const runtime = this.requireTaskRuntime(); const owner = this.taskOwner(options.owner);
    return this.trackTask(() => this.runCapability(`tasks/${action}`, options, (request) => action === "wait"
      ? runtime.wait(id, owner, request, options) : action === "update" ? runtime.update(id, owner, request, options) : runtime.get(id, owner, request), action === "wait" ? options.timeoutMs ?? 300_000 : undefined));
  }
  cancelTask(id: string, options: McpOperationOptions) {
    const runtime = this.requireTaskRuntime(); const owner = this.taskOwner(options.owner);
    return this.trackTask(() => this.runCapability("tasks/cancel", options, (request) => runtime.cancel(id, owner, request)));
  }
  private trackTask<T>(work: () => Promise<T>): Promise<T> {
    const operation = work(); this.taskOperations.add(operation);
    void operation.then(() => this.taskOperations.delete(operation), () => this.taskOperations.delete(operation));
    return operation;
  }
  private taskOwner(owner: McpInteractionOwner | undefined): McpInteractionOwner {
    if (!owner?.workspaceId || !owner.sessionId) throw taskFailure(this.options.id, "Tasks require a trusted workspace/Session owner");
    return owner;
  }
  private requireTaskRuntime(): McpTaskRuntime {
    if (this.taskRuntime === undefined) throw taskFailure(this.options.id, "Tasks are not enabled on this endpoint");
    return this.taskRuntime;
  }

  close(): Promise<void> { return this.closeResult ??= this.closeOwned(); }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    this.closed = true;
    this.lifetime.abort("MCP connection is closing");
    for (const app of this.appSessions) app.close();
    await Promise.allSettled(this.legacyOperations);
    await Promise.allSettled(this.taskOperations);
    await this.capabilities.close();
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
    if (this.closed) throw new McpConnectionError(this.options.id, "connection is closed; reconnect the server");
  }

  private handleClose(): void {
    if (this.closing || this.closed || !this.connected) return;
    this.closed = true;
    this.lifetime.abort("MCP connection closed");
    void this.capabilities.close();
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
    isDroppable: () => true,
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
  get interactions() { return this.options.interactions; }
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

  readResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.connection(serverId).capabilities.readResource(uri, { ...options, signal: this.signal(options.signal) });
  }

  readResourceTemplate(serverId: string, template: string, variables: Readonly<Record<string, string | string[]>>, options: McpReadOptions = {}) {
    return this.connection(serverId).capabilities.readTemplate(template, variables, { ...options, signal: this.signal(options.signal) });
  }

  getPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>, options: McpOperationOptions = {}) {
    return this.connection(serverId).capabilities.getPrompt(name, args, { ...options, signal: this.signal(options.signal) });
  }

  complete(serverId: string, params: McpCompletionParams, options: McpOperationOptions = {}) {
    return this.connection(serverId).capabilities.complete(params, { ...options, signal: this.signal(options.signal) });
  }

  subscribeResource(serverId: string, uri: string, options: McpOperationOptions = {}) {
    return this.connection(serverId).capabilities.subscribe(uri, { ...options, signal: this.signal(options.signal) });
  }

  openApp(serverId: string, name: string, options: McpAppOpenOptions) {
    return this.connection(serverId).openApp(name, { ...options, signal: this.signal(options.signal) });
  }

  async listTasks(owner: McpInteractionOwner) {
    if (this.closed) throw new McpClientPoolClosedError();
    return this.options.taskJournal?.list(owner) ?? [];
  }
  getTask(serverId: string, id: string, options: McpOperationOptions = {}) { return this.connection(serverId).taskOperation("get", id, { ...options, signal: this.signal(options.signal) }); }
  updateTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) { return this.connection(serverId).taskOperation("update", id, { ...options, signal: this.signal(options.signal) }); }
  waitTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) { return this.connection(serverId).taskOperation("wait", id, { ...options, signal: this.signal(options.signal) }); }
  cancelTask(serverId: string, id: string, options: McpOperationOptions = {}) { return this.connection(serverId).cancelTask(id, { ...options, signal: this.signal(options.signal) }); }
  async forgetTask(serverId: string, id: string, owner: McpInteractionOwner): Promise<void> {
    if (this.closed) throw new McpClientPoolClosedError();
    const record = (await this.listTasks(owner)).find((record) => record.id === id && record.binding.serverId === serverId);
    if (record === undefined) throw taskFailure(serverId, "task not owned by this Session");
    await this.options.taskJournal!.forget(id, owner, record.binding, this.lifetime.signal);
  }

  private connection(serverId: string): McpConnection {
    if (this.closed) throw new McpClientPoolClosedError();
    const connection = this.entry(serverId).connection;
    if (connection === undefined) throw new McpCapabilityError(serverId, "endpoint is unavailable; reconnect explicitly");
    return connection;
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
    this.options.interactions?.close();
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
        connection.updateCatalog(entry.catalog);
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
  if (options.apps !== undefined && (typeof options.apps.executor?.execute !== "function" || typeof options.apps.approve !== "function")) throw new McpConfigurationError("MCP Apps require a host permission executor and consent service");
  const serverIds = new Set<string>();
  for (const server of options.servers) {
    validateMcpServerOptions(server);
    if (server.tasks && options.taskJournal === undefined) throw new McpConfigurationError(`MCP server "${server.id}" enables Tasks without a task journal`);
    if (options.interactions !== undefined && (server.host?.roots && options.hostServices?.roots === undefined || server.host?.sampling && options.hostServices?.sampling === undefined)) throw new McpConfigurationError(`MCP server "${server.id}" enables a missing host service`);
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
    validateToolSchema(original.inputSchema);
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
      resultContent: (output: McpToolOutput) => mcpToolResultContent(connection.options.id, definition.name, output),
      execute: (input: Record<string, unknown>, context: ToolExecutionContext) =>
        connection.callTool(definition, exposedName, input, context, generation),
    });
  });
}

function validateToolSchema(value: unknown): void {
  const invalid = () => { throw new TypeError("MCP tool inputSchema is invalid or exceeds host limits"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { type?: unknown }).type !== "object") invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) invalid();
  let nodes = 0;
  const visit = (schema: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 32) invalid();
    if (typeof schema === "boolean") return;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) invalid();
    const record = schema as Record<string, unknown>;
    if (record.type !== undefined) {
      const types = typeof record.type === "string" ? [record.type] : Array.isArray(record.type) ? record.type : [];
      if (types.length === 0 || !types.every((type) => ["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) invalid();
    }
    if (record.required !== undefined && (!Array.isArray(record.required) || record.required.some((key) => typeof key !== "string") || new Set(record.required).size !== record.required.length)) invalid();
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

async function closeQuietly(client: McpHostClient): Promise<void> {
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
