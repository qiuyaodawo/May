import { randomUUID } from "node:crypto";
import { AsyncEventQueue, AsyncStateSerializer, omitUndefined, type Tool } from "@sortedyuan/may/core";
import { McpConnection, closeConnectionQuietly, fingerprint, freezeTree } from "./connection.js";
import { toDiagnostic } from "./transport-support.js";
import { McpClientPoolClosedError, McpCatalogError, McpCapabilityError, McpConfigurationError } from "./errors.js";
import { McpAuthenticationError } from "./oauth.js";
import { taskFailure } from "./tasks.js";
import type { McpAppOpenOptions } from "./apps.js";
import type { McpInteractionOwner } from "./interactions.js";
import type { McpTaskWaitOptions, McpTaskUpdateOptions } from "./task-runtime.js";
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
  OpenMcpClientPoolOptions,
} from "./types.js";

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

  connected(server: McpServerOptions, toolNames: readonly string[]): void {
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
    this.queue.push({
      type: "mcp.server.catalog-updated",
      seq: ++this.sequence,
      timestamp: Date.now(),
      serverId: server.id,
      transport: server.transport ?? "stdio",
      required: server.required !== false,
      revision,
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

interface PoolEntry {
  readonly server: McpServerOptions;
  readonly status: MutableMcpServerStatus;
  connection?: McpConnection;
  catalog?: McpServerCatalog;
  tools: readonly Tool[];
  invalidations: number;
  readonly operations: AsyncStateSerializer;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshScheduled?: boolean;
}

export class DefaultMcpClientPool implements McpClientPool {
  get interactions() {
    return this.options.interactions;
  }
  readonly events: AsyncIterable<McpClientEvent>;
  private readonly entries: PoolEntry[];
  private readonly lifetime = new AbortController();
  private readonly recorder = new McpEventRecorder();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: OpenMcpClientPoolOptions) {
    this.events = this.recorder.events;
    this.entries = options.servers.map((server) => ({
      server,
      tools: [],
      invalidations: 0,
      operations: new AsyncStateSerializer(),
      status: {
        serverId: server.id,
        transport: server.transport ?? "stdio",
        required: server.required !== false,
        state: "failed",
        toolNames: [],
      },
    }));
  }

  get tools(): readonly Tool[] {
    if (this.closed) return Object.freeze([]);
    return Object.freeze(
      this.entries
        .filter((entry) => entry.status.state === "connected" && entry.status.catalogStale !== true)
        .flatMap((entry) => entry.tools),
    );
  }

  catalog(): readonly McpServerCatalog[] {
    return Object.freeze(this.entries.flatMap((entry) => (entry.catalog === undefined ? [] : [entry.catalog])));
  }

  status(): readonly McpServerStatus[] {
    return this.entries.map(({ status, connection, catalog }) => {
      const stderr = connection?.stderrText() ?? status.diagnostic?.stderr;
      return {
        ...status,
        ...(connection === undefined ? {} : { catalogSubscription: connection.catalogSubscription }),
        toolNames: [...status.toolNames],
        ...omitUndefined({ catalogRevision: catalog?.revision, stderr }),
        ...(status.diagnostic === undefined ? {} : { diagnostic: { ...status.diagnostic } }),
      };
    });
  }

  readResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.connection(serverId).capabilities.readResource(uri, {
      ...options,
      signal: this.signal(options.signal),
    });
  }

  readResourceTemplate(
    serverId: string,
    template: string,
    variables: Readonly<Record<string, string | string[]>>,
    options: McpReadOptions = {},
  ) {
    return this.connection(serverId).capabilities.readTemplate(template, variables, {
      ...options,
      signal: this.signal(options.signal),
    });
  }

  getPrompt(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    options: McpOperationOptions = {},
  ) {
    return this.connection(serverId).capabilities.getPrompt(name, args, {
      ...options,
      signal: this.signal(options.signal),
    });
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
  getTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.connection(serverId).taskOperation("get", id, { ...options, signal: this.signal(options.signal) });
  }
  updateTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) {
    return this.connection(serverId).taskOperation("update", id, { ...options, signal: this.signal(options.signal) });
  }
  waitTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) {
    return this.connection(serverId).taskOperation("wait", id, { ...options, signal: this.signal(options.signal) });
  }
  cancelTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.connection(serverId).cancelTask(id, { ...options, signal: this.signal(options.signal) });
  }
  async forgetTask(serverId: string, id: string, owner: McpInteractionOwner): Promise<void> {
    if (this.closed) throw new McpClientPoolClosedError();
    const record = (await this.listTasks(owner)).find(
      (record) => record.id === id && record.binding.serverId === serverId,
    );
    if (record === undefined) throw taskFailure(serverId, "task not owned by this Session");
    await this.options.taskJournal!.forget(id, owner, record.binding, this.lifetime.signal);
  }

  private connection(serverId: string): McpConnection {
    if (this.closed) throw new McpClientPoolClosedError();
    const connection = this.entry(serverId).connection;
    if (connection === undefined)
      throw new McpCapabilityError(serverId, "endpoint is unavailable; reconnect explicitly");
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
    await Promise.all(this.entries.map((entry) => entry.operations.idle()));
    const failures: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.connection === undefined) continue;
      try {
        await entry.connection.close();
        entry.status.state = "disconnected";
        this.recorder.disconnected(entry.server);
      } catch (error) {
        failures.push(error);
        this.fail(entry, error);
      }
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
    return entry.operations.run(() => {
      this.lifetime.signal.throwIfAborted();
      return work();
    });
  }

  private async connect(entry: PoolEntry, signal: AbortSignal): Promise<void> {
    let connection: McpConnection | undefined;
    try {
      connection = await McpConnection.open(
        entry.server,
        { ...this.options, signal },
        (error) => {
          if (entry.connection !== connection || this.closed) return;
          if (error !== undefined) this.fail(entry, error);
        },
        () => {
          if (this.closed || (connection !== undefined && entry.connection !== connection)) return;
          entry.invalidations++;
          connection?.invalidate();
          entry.status.catalogStale = true;
          if (entry.connection === connection && connection !== undefined) this.scheduleRefresh(entry);
        },
      );
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
      void this.enqueue(entry, () => this.refreshEntry(entry, this.lifetime.signal))
        .catch(() => {})
        .finally(() => {
          entry.refreshScheduled = false;
        });
    }, 50);
  }

  private async refreshEntry(entry: PoolEntry, signal: AbortSignal, initial = false): Promise<void> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(entry.server.maxTotalTimeoutMs ?? 60_000)]);
    const connection = entry.connection;
    if (connection === undefined)
      throw new McpCatalogError(entry.server.id, "endpoint is unavailable; reconnect explicitly");
    try {
      // Retry discovery only, not tools; bound an invalidation storm.
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const stamp = entry.invalidations;
        const candidate = await connection.discover(signal);
        signal.throwIfAborted();
        if (stamp !== entry.invalidations) continue;
        const otherNames = new Set(
          this.entries.filter((other) => other !== entry).flatMap((other) => other.tools.map((tool) => tool.name)),
        );
        if (!initial && (entry.status.state === "auth-required" || entry.status.state === "failed"))
          connection.generation = randomUUID();
        const tools = connection.install(candidate.tools);
        if (tools.some((tool) => otherNames.has(tool.name)))
          throw new McpCatalogError(entry.server.id, "tool namespace collision");
        const changed =
          entry.catalog === undefined ||
          fingerprint(candidate) !==
            fingerprint({
              capabilities: entry.catalog.capabilities,
              tools: entry.catalog.tools,
              resources: entry.catalog.resources,
              resourceTemplates: entry.catalog.resourceTemplates,
              prompts: entry.catalog.prompts,
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
    entry.status.state =
      error instanceof McpAuthenticationError && error.code === "MCP_AUTHENTICATION_REQUIRED"
        ? "auth-required"
        : "failed";
    entry.status.diagnostic = toDiagnostic(error);
    this.recorder.failed(entry.server, entry.status.diagnostic);
  }
}
