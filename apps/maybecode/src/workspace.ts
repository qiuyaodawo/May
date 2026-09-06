import { resolve } from "node:path";

import { AgentWorkspace } from "@may/application";
import type {
  ContextBudget,
  ContextCompactionResult,
  ContextInspection,
} from "@may/context";
import {
  AsyncEventQueue,
  isStreamingMayEvent,
  type Model,
  type RunOptions,
} from "@may/core";
import { mcpResourceToUserMessage, mcpPromptToUserMessage, mcpTaskToUserMessage, type McpClientPool, type McpServerStatus,
  type McpOperationOptions, type McpReadOptions, type McpCompletionParams, type McpResourceSubscription,
  type McpInteractionBroker, type McpTaskWaitOptions, type McpTaskUpdateOptions,
} from "@may/mcp";
import type { ApprovalDecision } from "@may/permissions";
import type { ModelCapabilities } from "@may/providers";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
} from "@may/session";
import type { SessionCatalog, SessionSummary } from "@may/session/catalog";

import {
  MaybeCodeApplication,
  type MaybeCodeApplicationOptions,
} from "./application.js";
import type {
  MaybeCodeCompactionSelection,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type {
  MaybeCodeEvent,
  MaybeCodeRun,
  MaybeCodeSessionEvent,
} from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export interface MaybeCodeModelConfiguration {
  readonly model: Model;
  readonly modelInfo: MaybeCodeModelInfo;
  readonly contextBudget?: ContextBudget;
}

export interface MaybeCodeWorkspaceOptions extends Omit<
  MaybeCodeApplicationOptions,
  "sessionId" | "resume"
> {
  readonly catalog: SessionCatalog;
  readonly sessionId?: string;
  /** Resume the latest workspace session when no sessionId is given. Defaults to false. */
  readonly autoResume?: boolean;
  readonly modelProfiles?: readonly MaybeCodeModelProfile[];
  readonly createModelConfiguration?: (
    profile: string,
    runtimeOptions?: Readonly<Record<string, unknown>>,
  ) => MaybeCodeModelConfiguration | Promise<MaybeCodeModelConfiguration>;
  readonly resolveModelCapabilities?: (
    profile: string,
  ) => Promise<ModelCapabilities>;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  /** Optional product-owned MCP status and lifecycle event source. */
  readonly mcp?: Pick<McpClientPool, "events" | "status"> & Partial<Omit<McpClientPool, "events" | "status" | "tools" | "close">>;
  /** Product-owned resources, such as tracing processors, closed after the workspace. */
  readonly closeOwnedResources?: () => void | Promise<void>;
}

type MaybeCodeProductEvent = Exclude<MaybeCodeEvent, MaybeCodeSessionEvent | {
  type: "session.changed";
  sessionId: string;
  resumed: boolean;
}>;

type ActiveWorkspaceOptions = Omit<
  MaybeCodeWorkspaceOptions,
  "sessionId" | "autoResume"
>;

interface WorkspaceState {
  options: ActiveWorkspaceOptions;
}

type BaseWorkspace = AgentWorkspace<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection,
  MaybeCodeApplication
>;

/** MaybeCode model policy around the reusable multi-session workspace. */
export class MaybeCodeWorkspace implements MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;
  readonly workspace: string;

  private readonly manager: BaseWorkspace;
  private readonly state: WorkspaceState;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeEvent>({
    maxBufferedValues: 1024,
    isDroppable: (event) =>
      event.type === "mcp.resource.updated" || event.type === "run.event" && isStreamingMayEvent(event.event),
  });
  private readonly managerEventRelay: Promise<void>;
  private readonly mcpEventRelay: Promise<void>;
  private readonly interactionRelay: Promise<void>;
  private readonly modelOptionOverrides = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private closed = false;
  private readonly mcpLifetime = new AbortController();
  private mcpOperationController: AbortController | undefined;
  private readonly mcpWatches = new Map<string, McpResourceSubscription>();

  private constructor(state: WorkspaceState, manager: BaseWorkspace) {
    this.state = state;
    this.manager = manager;
    this.workspace = manager.workspace;
    this.events = this.eventQueue;
    this.managerEventRelay = this.relayEvents(manager.events);
    this.mcpEventRelay = state.options.mcp === undefined
      ? Promise.resolve()
      : this.relayEvents(state.options.mcp.events);
    this.interactionRelay = state.options.mcp?.interactions === undefined ? Promise.resolve() : this.relayEvents(state.options.mcp.interactions.events);
  }

  static async open(
    options: MaybeCodeWorkspaceOptions,
  ): Promise<MaybeCodeWorkspace> {
    const state: WorkspaceState = {
      options: withoutSelection({
        ...options,
        workspace: resolve(options.workspace),
      }),
    };
    const manager = await AgentWorkspace.open<
      MaybeCodeSessionEvent,
      MaybeCodeProductEvent,
      MaybeCodeCompactionSelection,
      MaybeCodeApplication
    >({
      workspace: state.options.workspace,
      store: state.options.store,
      catalog: state.options.catalog,
      openApplication: (selection) => MaybeCodeApplication.open({
        ...applicationOptions(state.options),
        ...(selection.sessionId === undefined
          ? {}
          : { sessionId: selection.sessionId }),
        resume: selection.resume,
      }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.autoResume === undefined
        ? {}
        : { autoResume: options.autoResume }),
    });
    return new MaybeCodeWorkspace(state, manager);
  }

  get sessionId(): string {
    return this.manager.sessionId;
  }

  get isRunning(): boolean {
    return this.manager.isRunning || this.mcpOperationController !== undefined;
  }

  get instructions(): MaybeCodeInstructions {
    return this.manager.activeApplication.instructions;
  }

  get modelInfo(): MaybeCodeModelInfo | undefined {
    return this.manager.activeApplication.modelInfo;
  }

  async getMcpStatus(): Promise<readonly McpServerStatus[]> {
    this.throwIfClosed();
    return this.state.options.mcp?.status() ?? [];
  }

  getMcpInteractions() {
    return this.state.options.mcp?.interactions?.list(this.mcpOwner()) ?? [];
  }

  respondMcpInteraction(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean {
    // Deliberately bypass the Session transition queue: submitPrepared/Run may
    // be waiting for this answer while holding that queue.
    if (this.closed) return false;
    const request = this.getMcpInteractions().find((entry) => entry.id === id);
    return request === undefined ? false : this.state.options.mcp!.interactions!.respond(id, request.owner, response);
  }

  private mcpOwner() { return { workspaceId: this.workspace, sessionId: this.sessionId }; }

  async refreshMcp(serverId?: string): Promise<void> {
    this.throwIfClosed();
    if (this.state.options.mcp?.refresh === undefined) throw new Error("MCP refresh is unavailable");
    await this.state.options.mcp.refresh(serverId);
  }

  async reconnectMcp(serverId: string): Promise<void> {
    this.throwIfClosed();
    if (this.state.options.mcp?.reconnect === undefined) throw new Error("MCP reconnect is unavailable");
    await this.state.options.mcp.reconnect(serverId);
  }

  getMcpCatalog() {
    this.throwIfClosed();
    return this.state.options.mcp?.catalog?.() ?? [];
  }

  listMcpTasks() {
    this.throwIfClosed();
    return this.state.options.mcp?.listTasks?.(this.mcpOwner()) ?? Promise.resolve([]);
  }
  getMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("getTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  updateMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("updateTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  waitMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("waitTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  cancelMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("cancelTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  forgetMcpTask(serverId: string, id: string) {
    return this.mcpOperation(() => this.manager.runStateTransition(() => this.mcpMethod("forgetTask")(serverId, id, this.mcpOwner())));
  }
  submitMcpTask(serverId: string, id: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpTaskToUserMessage(await this.mcpMethod("getTask")(serverId, id, { signal, owner: this.mcpOwner() }), instruction), signal,
    })));
  }

  readMcpResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("readResource")(serverId, uri, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  readMcpResourceTemplate(serverId: string, template: string, variables: Readonly<Record<string, string | string[]>>, options: McpReadOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("readResourceTemplate")(serverId, template, variables, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  getMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("getPrompt")(serverId, name, args, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  completeMcp(serverId: string, params: McpCompletionParams, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("complete")(serverId, params, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  submitMcpResource(serverId: string, uri: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpResourceToUserMessage(await this.mcpMethod("readResource")(serverId, uri, { signal, owner: this.mcpOwner() }), instruction), signal,
    })));
  }

  submitMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpPromptToUserMessage(await this.mcpMethod("getPrompt")(serverId, name, args, { signal, owner: this.mcpOwner() })), signal,
    })));
  }

  watchMcpResource(serverId: string, uri: string): Promise<McpResourceSubscription> {
    return this.mcpOperation(async (signal) => {
      const key = JSON.stringify([serverId, uri]);
      if (this.mcpWatches.has(key)) return this.mcpWatches.get(key)!;
      const watch = await this.mcpMethod("subscribeResource")(serverId, uri, { signal, owner: this.mcpOwner() });
      this.mcpWatches.set(key, watch);
      void (async () => {
        for await (const event of watch.events) {
          if (!this.closed) this.eventQueue.push({ type: "mcp.resource.updated", serverId, uri: event.uri });
        }
        const reason = await watch.closed;
        if (this.mcpWatches.get(key) === watch) this.mcpWatches.delete(key);
        if (!this.closed) this.eventQueue.push({ type: "mcp.resource.watch-closed", serverId, uri, reason });
      })();
      return watch;
    });
  }

  async unwatchMcpResource(serverId: string, uri: string): Promise<void> {
    this.throwIfClosed();
    await this.mcpWatches.get(JSON.stringify([serverId, uri]))?.close();
  }

  private mcpMethod<K extends "readResource" | "readResourceTemplate" | "getPrompt" | "complete" | "subscribeResource" | "getTask" | "updateTask" | "waitTask" | "cancelTask" | "forgetTask">(method: K): McpClientPool[K] {
    const mcp = this.state.options.mcp;
    if (mcp?.[method] === undefined) throw new Error(`MCP ${method} is unavailable`);
    return mcp[method].bind(mcp) as McpClientPool[K];
  }

  private async mcpOperation<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot start an MCP user operation while another operation is active");
    const controller = new AbortController();
    this.mcpOperationController = controller;
    const signal = AbortSignal.any([controller.signal, this.mcpLifetime.signal, ...(external === undefined ? [] : [external])]);
    try { signal.throwIfAborted(); return await work(signal); }
    finally { if (this.mcpOperationController === controller) this.mcpOperationController = undefined; }
  }

  submit(options: RunOptions): Promise<MaybeCodeRun> {
    return this.manager.submit(options);
  }

  retry(): Promise<MaybeCodeRun> {
    return this.manager.retry();
  }

  cancel(reason?: string): boolean {
    if (this.mcpOperationController !== undefined) { this.mcpOperationController.abort(reason); return true; }
    return this.manager.cancel(reason);
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    return this.manager.resolveApproval(requestId, decision);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.manager.listSessions();
  }

  newSession(): Promise<string> {
    return this.manager.newSession();
  }

  resumeSession(sessionId: string): Promise<void> {
    return this.manager.resumeSession(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.manager.renameSession(sessionId, title);
  }

  deleteSession(sessionId: string): Promise<boolean> {
    return this.manager.deleteSession(sessionId);
  }

  async listModels(): Promise<readonly MaybeCodeModelProfile[]> {
    this.throwIfClosed();
    return [...(this.state.options.modelProfiles ?? [])];
  }

  async switchModel(profile: string): Promise<MaybeCodeModelInfo> {
    this.throwIfClosed();
    const selected = (this.state.options.modelProfiles ?? []).find((candidate) =>
      candidate.name === profile
    );
    if (selected === undefined) throw new Error(`Unknown model profile "${profile}"`);

    if (this.modelInfo?.profile === profile) {
      return this.manager.runStateTransition((application) => {
        const model = application.modelInfo;
        if (model === undefined) {
          throw new Error("The active application does not expose model information");
        }
        this.manager.emit({ type: "model.changed", model });
        return model;
      }, {
        activeOperationMessage:
          "Cannot switch sessions while an operation is active",
      });
    }

    let result: MaybeCodeModelInfo | undefined;
    await this.manager.transitionApplication(async (current) => {
      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot switch models");
      }
      const configuration = await create(
        profile,
        this.modelOptionOverrides.get(profile),
      );
      if (configuration.modelInfo.profile !== profile) {
        throw new Error(
          `Model configuration for "${profile}" returned profile ` +
            `"${configuration.modelInfo.profile ?? "unknown"}"`,
        );
      }
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
      );
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      result = configuration.modelInfo;
      return next;
    }, {
      createEvent: (application) => ({
        type: "model.changed",
        model: application.modelInfo!,
      }),
    });
    return result!;
  }

  setDefaultModel(profile: string): Promise<void> {
    this.throwIfClosed();
    return this.manager.runStateTransition(async () => {
      const profiles = this.state.options.modelProfiles ?? [];
      if (!profiles.some((candidate) => candidate.name === profile)) {
        throw new Error(`Unknown model profile "${profile}"`);
      }
      const persist = this.state.options.persistDefaultModel;
      if (persist === undefined) {
        throw new Error("The active MaybeCode configuration is not writable");
      }

      await persist(profile);
      this.state.options = {
        ...this.state.options,
        modelProfiles: profiles.map((candidate) => ({
          ...candidate,
          isDefault: candidate.name === profile,
        })),
      };
      this.manager.emit({ type: "model.default.changed", profile });
    }, { requireIdle: false });
  }

  async getReasoningEffort(): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    const profile = this.modelInfo?.profile;
    if (profile === undefined) return unknownReasoningEffort();
    const resolveCapabilities = this.state.options.resolveModelCapabilities;
    if (resolveCapabilities === undefined) return unknownReasoningEffort();

    const capabilities = (await resolveCapabilities(profile)).reasoningEffort;
    const configured = (this.state.options.modelProfiles ?? []).find(
      (candidate) => candidate.name === profile,
    )?.reasoningEffort;
    const override = this.modelOptionOverrides.get(profile)?.reasoningEffort;
    const overridden = typeof override === "string";
    const effectiveEffort = overridden
      ? override
      : configured ?? (
        capabilities.status === "known"
          ? capabilities.defaultEffort
          : undefined
      );
    return {
      status: capabilities.status,
      source: capabilities.source,
      efforts: capabilities.status === "known"
        ? [...capabilities.efforts]
        : [],
      ...(capabilities.status === "known" &&
          capabilities.defaultEffort !== undefined
        ? { defaultEffort: capabilities.defaultEffort }
        : {}),
      ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
      overridden,
    };
  }

  async setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    await this.manager.transitionApplication(async (current) => {
      const profile = current.modelInfo?.profile;
      if (profile === undefined) {
        throw new Error("The active model has no configurable profile");
      }
      const state = await this.getReasoningEffort();
      if (effort !== undefined) {
        if (state.status === "unknown") {
          throw new Error(
            `Reasoning effort capabilities are unknown for model profile "${profile}"`,
          );
        }
        if (state.status === "unsupported") {
          throw new Error(
            `Model profile "${profile}" does not support effort-based reasoning`,
          );
        }
        if (!state.efforts.includes(effort)) {
          throw new Error(
            `Reasoning effort "${effort}" is unsupported by model profile ` +
              `"${profile}"; supported values: ${state.efforts.join(", ")}`,
          );
        }
        this.modelOptionOverrides.set(profile, { reasoningEffort: effort });
      } else {
        this.modelOptionOverrides.delete(profile);
      }

      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot tune models");
      }
      const configuration = await create(
        profile,
        this.modelOptionOverrides.get(profile),
      );
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
      );
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      return next;
    });
    return this.getReasoningEffort();
  }

  history() {
    return this.manager.history();
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.manager.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.manager.inspectContext();
  }

  compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    return this.manager.compactContext(strategy);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.mcpLifetime.abort("MaybeCode workspace is closing");
    const watchesClosing = Promise.allSettled([...this.mcpWatches.values()].map((watch) => watch.close()));
    const failures: unknown[] = [];
    try {
      await this.manager.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.state.options.closeOwnedResources?.();
    } catch (error) {
      failures.push(error);
    }
    await watchesClosing;
    try {
      await Promise.all([this.managerEventRelay, this.mcpEventRelay, this.interactionRelay]);
    } catch (error) {
      failures.push(error);
    } finally {
      this.eventQueue.close();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MaybeCode workspace failed to close");
    }
  }

  private async relayEvents(events: AsyncIterable<MaybeCodeEvent>): Promise<void> {
    for await (const event of events) {
      if (event.type === "mcp.interaction.requested" &&
          (event.request.owner.workspaceId !== this.workspace || event.request.owner.sessionId !== this.sessionId)) continue;
      this.eventQueue.push(event);
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
}

function withoutSelection(
  options: MaybeCodeWorkspaceOptions,
): ActiveWorkspaceOptions {
  const { sessionId: _sessionId, autoResume: _autoResume, ...base } = options;
  return base;
}

function applicationOptions(
  options: ActiveWorkspaceOptions,
): MaybeCodeApplicationOptions {
  const {
    catalog: _catalog,
    modelProfiles: _modelProfiles,
    createModelConfiguration: _createModelConfiguration,
    resolveModelCapabilities: _resolveModelCapabilities,
    persistDefaultModel: _persistDefaultModel,
    closeOwnedResources: _closeOwnedResources,
    mcp: _mcp,
    ...application
  } = options;
  return application;
}

function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

function withModelConfiguration(
  options: ActiveWorkspaceOptions,
  configuration: MaybeCodeModelConfiguration,
): ActiveWorkspaceOptions {
  const {
    model: _model,
    modelInfo: _modelInfo,
    contextBudget: _contextBudget,
    ...unchanged
  } = options;
  return {
    ...unchanged,
    model: configuration.model,
    modelInfo: configuration.modelInfo,
    ...(configuration.contextBudget === undefined
      ? {}
      : { contextBudget: configuration.contextBudget }),
  };
}
