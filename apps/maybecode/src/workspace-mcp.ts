import {
  mcpResourceToUserMessage,
  mcpPromptToUserMessage,
  mcpTaskToUserMessage,
  type McpClientPool,
  type McpServerStatus,
  type McpOperationOptions,
  type McpReadOptions,
  type McpCompletionParams,
  type McpResourceSubscription,
  type McpInteractionBroker,
  type McpTaskWaitOptions,
  type McpTaskUpdateOptions,
} from "@sortedyuan/mcp";
import type { MaybeCodeApplication } from "./application.js";
import type { MaybeCodeEvent, MaybeCodeRun } from "./events.js";
import type { BaseWorkspace } from "./workspace-state.js";
import type { MaybeCodeWorkspaceOptions } from "./workspace.js";

export interface MaybeCodeWorkspaceMcpHost {
  readonly workspace: () => string;
  readonly sessionId: () => string;
  readonly application: () => MaybeCodeApplication;
  readonly configuredMcp: () => MaybeCodeWorkspaceOptions["mcp"];
  readonly closed: () => boolean;
  readonly isRunning: () => boolean;
  readonly throwIfClosed: () => void;
  readonly assertNoWorkspaceOperation: () => void;
  readonly ownsSession: (sessionId: string) => boolean;
  readonly transition: <T>(action: () => T | Promise<T>) => Promise<T>;
  readonly submitPrepared: BaseWorkspace["submitPrepared"];
  readonly push: (event: MaybeCodeEvent) => void;
  readonly cancel: (reason: string) => void;
}

export class MaybeCodeWorkspaceMcp {
  readonly mcpEventRelays = new Set<Promise<void>>();
  private readonly mcpEventIterators = new Set<AsyncIterator<MaybeCodeEvent>>();
  readonly mcpRelayErrors: unknown[] = [];
  private observedMcp: MaybeCodeWorkspaceOptions["mcp"];
  private readonly mcpLifetime = new AbortController();
  private mcpOperationController: AbortController | undefined;
  private readonly mcpWatches = new Map<string, McpResourceSubscription>();

  constructor(private readonly host: MaybeCodeWorkspaceMcpHost) {}

  get busy(): boolean {
    return this.mcpOperationController !== undefined;
  }

  abortOperation(reason?: string): void {
    this.mcpOperationController?.abort(reason);
  }

  closeWatches(reason: string): Promise<PromiseSettledResult<void>[]> {
    this.mcpLifetime.abort(reason);
    return Promise.allSettled([...this.mcpWatches.values()].map((watch) => watch.close()));
  }

  async getMcpStatus(): Promise<readonly McpServerStatus[]> {
    this.host.throwIfClosed();
    return this.mcp?.status() ?? [];
  }

  private get mcp(): MaybeCodeWorkspaceOptions["mcp"] {
    return this.host.application().mcp ?? this.host.configuredMcp();
  }

  getMcpInteractions() {
    const interactions = this.mcp?.interactions;
    if (interactions === undefined) return [];
    return [
      this.mcpOwner(),
      ...this.delegatedSessions().map((sessionId) => ({ workspaceId: this.host.workspace(), sessionId })),
    ].flatMap((owner) => [...interactions.list(owner)]);
  }

  respondMcpInteraction(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean {
    // Deliberately bypass the Session transition queue: submitPrepared/Run may
    // be waiting for this answer while holding that queue.
    if (this.host.closed()) return false;
    const request = this.getMcpInteractions().find((entry) => entry.id === id);
    return request === undefined ? false : this.mcp!.interactions!.respond(id, request.owner, response);
  }

  private mcpOwner() {
    return { workspaceId: this.host.workspace(), sessionId: this.host.sessionId() };
  }

  /** 活动请求的子 Session 保留自己的 MCP 身份与授权记录。 */
  private delegatedSessions(): readonly string[] {
    return this.host.application().ownedDelegatedSessions();
  }

  async refreshMcp(serverId?: string): Promise<void> {
    this.host.assertNoWorkspaceOperation();
    this.host.throwIfClosed();
    const mcp = this.mcp;
    if (mcp?.refresh === undefined) throw new Error("MCP refresh is unavailable");
    await mcp.refresh(serverId);
  }

  async reconnectMcp(serverId: string): Promise<void> {
    this.host.assertNoWorkspaceOperation();
    this.host.throwIfClosed();
    const mcp = this.mcp;
    if (mcp?.reconnect === undefined) throw new Error("MCP reconnect is unavailable");
    await mcp.reconnect(serverId);
  }

  getMcpCatalog() {
    this.host.throwIfClosed();
    return this.mcp?.catalog?.() ?? [];
  }

  listMcpTasks() {
    this.host.throwIfClosed();
    return this.mcp?.listTasks?.(this.mcpOwner()) ?? Promise.resolve([]);
  }
  getMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("getTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }
  updateMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("updateTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }
  waitMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("waitTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }
  cancelMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("cancelTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }
  forgetMcpTask(serverId: string, id: string) {
    return this.mcpOperation(() =>
      this.host.transition(() => this.mcpMethod("forgetTask")(serverId, id, this.mcpOwner())),
    );
  }
  submitMcpTask(serverId: string, id: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) =>
      this.host.submitPrepared(async () => ({
        input: mcpTaskToUserMessage(
          await this.mcpMethod("getTask")(serverId, id, { signal, owner: this.mcpOwner() }),
          instruction,
        ),
        signal,
      })),
    );
  }

  readMcpResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("readResource")(serverId, uri, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }

  readMcpResourceTemplate(
    serverId: string,
    template: string,
    variables: Readonly<Record<string, string | string[]>>,
    options: McpReadOptions = {},
  ) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("readResourceTemplate")(serverId, template, variables, {
            ...options,
            signal,
            owner: this.mcpOwner(),
          }),
        ),
      options.signal,
    );
  }

  getMcpPrompt(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    options: McpOperationOptions = {},
  ) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("getPrompt")(serverId, name, args, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }

  completeMcp(serverId: string, params: McpCompletionParams, options: McpOperationOptions = {}) {
    return this.mcpOperation(
      (signal) =>
        this.host.transition(() =>
          this.mcpMethod("complete")(serverId, params, { ...options, signal, owner: this.mcpOwner() }),
        ),
      options.signal,
    );
  }

  submitMcpResource(serverId: string, uri: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) =>
      this.host.submitPrepared(async () => ({
        input: mcpResourceToUserMessage(
          await this.mcpMethod("readResource")(serverId, uri, { signal, owner: this.mcpOwner() }),
          instruction,
        ),
        signal,
      })),
    );
  }

  submitMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) =>
      this.host.submitPrepared(async () => ({
        input: mcpPromptToUserMessage(
          await this.mcpMethod("getPrompt")(serverId, name, args, { signal, owner: this.mcpOwner() }),
        ),
        signal,
      })),
    );
  }

  watchMcpResource(serverId: string, uri: string): Promise<McpResourceSubscription> {
    return this.mcpOperation(async (signal) => {
      const owner = this.mcpOwner();
      const key = JSON.stringify([owner.workspaceId, owner.sessionId, serverId, uri]);
      if (this.mcpWatches.has(key)) return this.mcpWatches.get(key)!;
      const watch = await this.mcpMethod("subscribeResource")(serverId, uri, { signal, owner: this.mcpOwner() });
      this.mcpWatches.set(key, watch);
      this.trackMcpRelay(
        (async () => {
          for await (const event of watch.events) {
            if (
              !this.host.closed() &&
              owner.workspaceId === this.host.workspace() &&
              owner.sessionId === this.host.sessionId()
            )
              this.host.push({ type: "mcp.resource.updated", serverId, uri: event.uri });
          }
          const reason = await watch.closed;
          if (this.mcpWatches.get(key) === watch) this.mcpWatches.delete(key);
          if (
            !this.host.closed() &&
            owner.workspaceId === this.host.workspace() &&
            owner.sessionId === this.host.sessionId()
          )
            this.host.push({ type: "mcp.resource.watch-closed", serverId, uri, reason });
        })(),
      );
      return watch;
    });
  }

  async unwatchMcpResource(serverId: string, uri: string): Promise<void> {
    this.host.throwIfClosed();
    await this.mcpWatches.get(JSON.stringify([this.host.workspace(), this.host.sessionId(), serverId, uri]))?.close();
  }

  private mcpMethod<
    K extends
      | "readResource"
      | "readResourceTemplate"
      | "getPrompt"
      | "complete"
      | "subscribeResource"
      | "getTask"
      | "updateTask"
      | "waitTask"
      | "cancelTask"
      | "forgetTask",
  >(method: K): McpClientPool[K] {
    const mcp = this.mcp;
    if (mcp?.[method] === undefined) throw new Error(`MCP ${method} is unavailable`);
    return mcp[method].bind(mcp) as McpClientPool[K];
  }

  private async mcpOperation<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.host.throwIfClosed();
    if (this.host.isRunning()) throw new Error("Cannot start an MCP user operation while another operation is active");
    const controller = new AbortController();
    this.mcpOperationController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      this.mcpLifetime.signal,
      ...(external === undefined ? [] : [external]),
    ]);
    try {
      signal.throwIfAborted();
      return await work(signal);
    } finally {
      if (this.mcpOperationController === controller) this.mcpOperationController = undefined;
    }
  }

  connectMcpEvents(): void {
    if (this.host.closed()) return;
    const mcp = this.mcp;
    if (mcp === this.observedMcp) return;
    this.trackMcpRelay(this.disconnectMcpEvents());
    this.observedMcp = mcp;
    for (const events of [mcp?.events, mcp?.interactions?.events]) {
      if (events === undefined) continue;
      const iterator = events[Symbol.asyncIterator]();
      this.mcpEventIterators.add(iterator);
      this.trackMcpRelay(
        (async () => {
          try {
            while (true) {
              const next = await iterator.next();
              if (next.done) return;
              const event = next.value;
              if (
                event.type === "mcp.interaction.requested" &&
                (event.request.owner.workspaceId !== this.host.workspace() ||
                  !this.host.ownsSession(event.request.owner.sessionId))
              )
                continue;
              this.host.push(event);
            }
          } finally {
            this.mcpEventIterators.delete(iterator);
          }
        })(),
      );
    }
  }

  async disconnectMcpEvents(): Promise<void> {
    const iterators = [...this.mcpEventIterators];
    this.mcpEventIterators.clear();
    this.observedMcp = undefined;
    const results = await Promise.allSettled(
      iterators.map(async (iterator) => {
        await iterator.return?.();
      }),
    );
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "MCP event streams failed to close");
  }

  private trackMcpRelay(operation: Promise<void>): void {
    const task = operation.then(
      () => {
        this.mcpEventRelays.delete(task);
      },
      (error) => {
        this.mcpEventRelays.delete(task);
        this.mcpRelayErrors.push(error);
        if (!this.host.closed()) this.host.cancel("MCP event forwarding failed");
      },
    );
    this.mcpEventRelays.add(task);
  }
}
