import { assembleRuntime } from "./runtime-assembly.js";
import { completeApplicationOpening } from "./opening-completion.js";
import { connectRuntimeHooks, prepareInput, relayRunEvents, relayPermissionEvents } from "./application-events.js";
import { openApplicationPlugins } from "./opening-plugins.js";
import { assembleOpeningTools, recordToolPresentation } from "./opening-tools.js";
import { openApplicationSession, validateOpenedSession, connectPermissionEvents } from "./opening-session.js";
import {
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextController,
  type ContextInspection,
} from "../context/index.js";
import {
  AsyncEventQueue,
  endTraceSpan,
  isStreamingMayEvent,
  omitUndefined,
  startTraceSpan,
  traceError,
  type Message,
  type RunHandle,
  type Tracer,
  type AgentRuntime,
  type HookContext,
} from "../core/index.js";
import { randomUUID } from "node:crypto";
import type { PluginHost, AnyPlugin, ServiceToken } from "../plugin/index.js";
import {
  type PermissionToolExecutor,
  type ApprovalDecision,
  type ApprovalResolveOptions,
  type CreatePermissionRuleOptions,
  type PermissionCheck,
  type PersistentPermissionRule,
} from "../permissions/index.js";
import {
  type Session,
  createSessionId,
  type SessionContinueOptions,
  type SessionEvent,
  type SessionHistoryPage,
  type SessionHistoryQuery,
  type SessionRuntimeInfo,
  type SessionBranchPosition,
  type SessionSteerOptions,
  type SessionSteeringInput,
  type SessionSubmitOptions,
} from "../session/index.js";

import type { SteerableAgentController } from "./controller.js";
import type { SkillSession } from "../skills/index.js";
import type { AgentApplicationEvent, AgentRun } from "./events.js";
import {
  startCompaction,
  awaitCompaction,
  assertCompactionAvailable,
  type ActiveCompaction,
  recordAutomaticCompaction,
  recordAutomaticCompactionFailure,
} from "./application-compaction.js";
import { latestRunFailed } from "./session-navigation.js";
export { contextBudgetFromModel, withDefaultCompactionThreshold } from "./compaction-controller.js";
import { applicationHooks, type InputHook } from "./hooks.js";
import { applicationServices, type PluginUpdateOptions } from "./plugins.js";

type ApplicationPluginScope = Awaited<ReturnType<PluginHost["createScope"]>>;

import type { AgentApplicationOptions } from "./options.js";
export type { AgentApplicationOptions, AgentApplicationFork, AgentToolPresentation } from "./options.js";

/**
 * Reusable, headless lifecycle for one durable May agent session.
 * @public
 */
export class AgentApplication implements SteerableAgentController {
  /** @experimental */
  readonly events: AsyncIterable<AgentApplicationEvent>;
  /** @experimental */
  readonly sessionId: string;
  /** @experimental */
  readonly metadata: Readonly<Record<string, unknown>> | undefined;

  private readonly session: Session;
  private readonly permissions: PermissionToolExecutor;
  private contextController: ContextController | undefined;
  private readonly readCompactionStrategy: () => ContextCompactionStrategy | undefined;
  private readonly closeReason: string;
  private readonly tracer: Tracer | undefined;
  private readonly eventQueue = new AsyncEventQueue<AgentApplicationEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) => value.type === "run.event" && isStreamingMayEvent(value.event),
  });
  private readonly permissionRelay: Promise<void>;
  private readonly runRelays = new Set<Promise<void>>();
  private readonly lifecycleController = new AbortController();
  private currentRun: AgentRun | undefined;
  private startingRun: RunHandle | undefined;
  private startingController: AbortController | undefined;
  private activeCompaction: ActiveCompaction | undefined;
  private starting = false;
  private closed = false;
  private stateRecordingClosed = false;
  private readonly pendingStateWrites = new Set<Promise<void>>();
  private closePromise: Promise<void> | undefined;
  private changingPlugins = false;
  private pluginChangeTail: Promise<void> = Promise.resolve();
  private pendingPluginChanges = 0;
  private currentStart: Promise<void> | undefined;
  private runStartBarrier: Promise<void> | undefined;
  private pluginFailure: unknown;
  private activeRunScope: ApplicationPluginScope | undefined;
  private readonly pluginHost: PluginHost;
  private readonly applicationScope: ApplicationPluginScope;
  private readonly sessionScope: ApplicationPluginScope;
  private readonly createRuntime: (messages?: Message[], info?: SessionRuntimeInfo) => Promise<AgentRuntime>;
  private readonly readContextController: () => ContextController | undefined;
  private readonly reconfigurePlugins: (plugins: readonly AnyPlugin[], options: PluginUpdateOptions) => Promise<void>;
  private readonly validatePlugins: (plugins: readonly AnyPlugin[]) => void;
  private readonly validateToolCatalog: () => void;

  private constructor(
    session: Session,
    permissions: PermissionToolExecutor,
    contextController: ContextController | undefined,
    readCompactionStrategy: () => ContextCompactionStrategy | undefined,
    closeReason: string,
    tracer: Tracer | undefined,
    pluginHost: PluginHost,
    applicationScope: ApplicationPluginScope,
    sessionScope: ApplicationPluginScope,
    createRuntime: (messages?: Message[], info?: SessionRuntimeInfo) => Promise<AgentRuntime>,
    readContextController: () => ContextController | undefined,
    reconfigurePlugins: (plugins: readonly AnyPlugin[], options: PluginUpdateOptions) => Promise<void>,
    validatePlugins: (plugins: readonly AnyPlugin[]) => void,
    validateToolCatalog: () => void,
  ) {
    this.session = session;
    this.pluginHost = pluginHost;
    this.applicationScope = applicationScope;
    this.sessionScope = sessionScope;
    this.createRuntime = createRuntime;
    this.readContextController = readContextController;
    this.reconfigurePlugins = reconfigurePlugins;
    this.validatePlugins = validatePlugins;
    this.validateToolCatalog = validateToolCatalog;
    this.sessionId = session.id;
    this.metadata = session.metadata;
    this.permissions = permissions;
    this.contextController = contextController;
    this.readCompactionStrategy = readCompactionStrategy;
    this.closeReason = closeReason;
    this.tracer = tracer;
    this.events = this.eventQueue;
    this.permissionRelay = relayPermissionEvents(this.permissions, (event) => this.eventQueue.push(event));
  }

  /** @public */
  static async open(options: AgentApplicationOptions): Promise<AgentApplication> {
    const sessionId = options.sessionId ?? createSessionId();
    if (options.resume === true && options.sessionId === undefined)
      throw new Error("sessionId is required when resuming a session");
    if (options.resume === true && options.fork !== undefined)
      throw new Error("Session resume and fork cannot be combined");
    let application: AgentApplication | undefined;
    let contextController: ContextController | undefined;
    let historySource: Session | undefined;
    const plugins = await openApplicationPlugins(
      options,
      sessionId,
      () => {
        if (application === undefined) throw new Error("AgentApplication is unavailable before application.created");
        if (application.stateRecordingClosed) throw new Error("Agent application is closed");
        return application;
      },
      () => historySource,
      () => contextController,
    );
    options = plugins.options;
    const { pluginHost, applicationScope, sessionScope, transformForkState } = plugins;
    const hooks = connectRuntimeHooks(
      sessionId,
      () => application?.activeRunScope ?? sessionScope,
      () => application?.runStartBarrier,
    );
    let cleanupPermissions: PermissionToolExecutor | undefined;
    let pendingRuntime: AgentRuntime | undefined;
    let openedSession: Session | undefined;
    let openSpan: ReturnType<typeof startTraceSpan>;
    try {
      const { configuredTools, validateToolCatalog, tracer, permissions } = assembleOpeningTools(
        options,
        sessionScope,
        () => historySource,
        async (check, presentation) => {
          if (application === undefined) throw new Error("Tool presentation requested before session creation");
          await recordToolPresentation(application.session, check, presentation, (event) =>
            application!.eventQueue.push(event),
          );
        },
      );
      cleanupPermissions = permissions;

      const { createRuntime, readCompactionStrategy } = assembleRuntime(
        options,
        sessionId,
        sessionScope,
        hooks,
        configuredTools,
        permissions,
        tracer,
        validateToolCatalog,
        () => historySource,
        plugins.configuredPlugins,
        (controller) => {
          contextController = controller;
        },
        (runtime) => {
          if (runtime === undefined || openedSession === undefined) pendingRuntime = runtime;
        },
      );

      openSpan = startTraceSpan(tracer, "may.application.open", {
        attributes: {
          ...(options.traceAttributes ?? {}),
          "may.application.resume": options.resume === true,
          ...(options.sessionId === undefined ? {} : { "may.session.id": options.sessionId }),
        },
      });
      const session = await openApplicationSession(options, sessionId, transformForkState, createRuntime, () => {
        pendingRuntime = undefined;
      });
      historySource = session;
      openedSession = session;
      pendingRuntime = undefined;
      await validateOpenedSession(options, session);
      connectPermissionEvents(permissions, session, hooks, sessionId);
      application = new AgentApplication(
        session,
        permissions,
        contextController,
        readCompactionStrategy,
        options.closeReason ?? "Agent application is closing",
        tracer,
        pluginHost,
        applicationScope,
        sessionScope,
        createRuntime,
        () => contextController,
        plugins.reconfigurePlugins,
        plugins.validatePlugins,
        validateToolCatalog,
      );
      await completeApplicationOpening(
        session,
        sessionScope,
        plugins.persistInitialState,
        () => application!.connectCompactionSinks(),
        () => application!.hookContext(),
        validateToolCatalog,
        options.fork !== undefined,
        application.pendingStateWrites,
      );
      endTraceSpan(openSpan, {
        status: "ok",
        attributes: { "may.session.id": session.id },
      });
      return application;
    } catch (error) {
      endTraceSpan(openSpan, { status: "error", error: traceError(error) });
      const failures: unknown[] = [error];
      const cleanup = async (operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      };
      if (application !== undefined) await cleanup(() => application!.close());
      else {
        await cleanup(() => cleanupPermissions?.close());
        await cleanup(() => openedSession?.closeRuntime());
        await cleanup(() => pendingRuntime?.close?.());
        await cleanup(() => pluginHost.close());
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "Agent application initialization and cleanup failed", { cause: error });
      throw error;
    }
  }

  /** @experimental */
  get isRunning(): boolean {
    return (
      this.starting || this.changingPlugins || this.currentRun !== undefined || this.activeCompaction !== undefined
    );
  }

  /** @experimental */
  get skills(): SkillSession | undefined {
    return this.sessionScope.provides(applicationServices.skills)
      ? this.sessionScope.get(applicationServices.skills)
      : undefined;
  }

  /** Persist application-owned session memory; available during tool execution. */
  /** @experimental */
  recordState(key: string, value: unknown): Promise<void> {
    if (this.stateRecordingClosed) throw new Error("Agent application is closed");
    const writing = this.session.recordState(key, value);
    this.pendingStateWrites.add(writing);
    void writing.then(
      () => this.pendingStateWrites.delete(writing),
      () => this.pendingStateWrites.delete(writing),
    );
    return writing;
  }

  /** @public */
  submit(options: SessionSubmitOptions): Promise<AgentRun> {
    assertSessionInputOptions(options);
    let input: InputHook;
    return this.startRun(
      async () => {
        input = await this.prepareInput(
          omitUndefined({ input: options.input, inputId: options.inputId }),
          options.signal,
        );
        return this.session.submit({
          ...options,
          input: input.input,
          signal: this.hookContext(options.signal).signal,
          ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
        });
      },
      (run) =>
        this.hookScope().observe(
          applicationHooks.inputSubmitted,
          { ...input, runId: run.id },
          this.hookContext(options.signal),
        ),
      options.signal,
    );
  }

  /** @experimental */
  async steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    this.throwIfClosed();
    if (this.starting || this.changingPlugins || this.activeCompaction !== undefined)
      throw new Error("Cannot steer while an agent operation is starting or compacting context");
    const input = await this.prepareInput(
      omitUndefined({ input: options.input, steering: true, inputId: options.inputId }),
    );
    const result = await this.session.steer({
      ...options,
      input: input.input,
      ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    });
    await this.hookScope().observe(
      applicationHooks.inputSubmitted,
      { ...input, inputId: result.inputId },
      this.hookContext(),
    );
    return result;
  }

  /** @experimental */
  listSteeringInputs(): readonly SessionSteeringInput[] {
    return this.session.listSteeringInputs();
  }

  /** @experimental */
  cancelSteeringInputs(reason = "Cancelled by user"): Promise<void> {
    this.throwIfClosed();
    return this.session.cancelSteeringInputs(reason);
  }

  /** @experimental */
  startSteeringInput(
    inputId: string,
    options: Omit<SessionSubmitOptions, "input" | "inputId"> = {},
  ): Promise<AgentRun> {
    assertSessionInputOptions(options);
    return this.startRun(
      () => this.session.startSteeringInput(inputId, { ...options, signal: this.hookContext(options.signal).signal }),
      undefined,
      options.signal,
    );
  }

  /** 在当前上下文中继续执行，沿用运行互斥和保存流程。 */
  /** @experimental */
  continue(options: SessionContinueOptions = {}): Promise<AgentRun> {
    assertSessionInputOptions(options);
    return this.startRun(
      () => this.session.continue({ ...options, signal: this.hookContext(options.signal).signal }),
      undefined,
      options.signal,
    );
  }

  /** @experimental */
  listRecoveries() {
    return this.session.listRecoveries();
  }

  /** @experimental */
  async activateSkill(name: string) {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot activate a skill while an operation is active");
    if (!this.skills) throw new Error("Skills are disabled");
    this.starting = true;
    try {
      return await this.skills.activate(name);
    } finally {
      this.starting = false;
    }
  }

  /** @experimental */
  async resolveRecovery(id: string, finding: string): Promise<void> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot resolve recovery while an operation is active");
    const result = await this.sessionScope.transform(
      applicationHooks.recoveryBefore,
      { id, finding },
      this.hookContext(),
    );
    if (result.id !== id) throw new Error("Recovery identity cannot be changed by a Hook");
    await this.session.resolveRecovery(result.id, result.finding);
    await this.sessionScope.observe(applicationHooks.recoveryResolved, result, this.hookContext());
  }

  /** Retry the latest failed run without adding another user message. */
  /** @experimental */
  retry(): Promise<AgentRun> {
    return this.startRun(async () => {
      if (!latestRunFailed(await this.session.history())) {
        throw new Error("The latest run did not fail; there is nothing to retry");
      }
      return this.session.continue({ signal: this.hookContext().signal });
    });
  }

  private async startRun(
    start: () => Promise<RunHandle>,
    afterStart?: (run: RunHandle) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    this.throwIfClosed();
    if (this.pluginFailure !== undefined)
      throw new Error("Plugin configuration is unavailable; update plugins before starting a Run", {
        cause: this.pluginFailure,
      });
    if (this.isRunning) throw new Error("An agent operation is already active");

    this.starting = true;
    this.startingController = new AbortController();
    let finishStart!: () => void;
    this.currentStart = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    let runScope: ApplicationPluginScope | undefined;
    let acquiredRun: RunHandle | undefined;
    let releaseBarrier: (() => void) | undefined;
    let rejectBarrier: ((error: unknown) => void) | undefined;
    if (afterStart !== undefined) {
      this.runStartBarrier = new Promise<void>((resolve, reject) => {
        releaseBarrier = resolve;
        rejectBarrier = reject;
      });
      void this.runStartBarrier.catch(() => undefined);
    }
    try {
      runScope = await this.sessionScope.createScope("run", {
        id: `run-${randomUUID()}`,
        signal: this.hookContext(signal).signal,
      });
      this.activeRunScope = runScope;
      const run = await start();
      acquiredRun = run;
      this.startingRun = run;
      await afterStart?.(run);
      releaseBarrier?.();
      this.runStartBarrier = undefined;
      if (this.closed) {
        run.cancel(this.closeReason);
        await run.result.catch(() => undefined);
        this.throwIfClosed();
      }
      const relay = relayRunEvents(
        run.events,
        () => this.contextController,
        (event) => this.eventQueue.push(event),
      );
      this.runRelays.add(relay);
      void relay.then(
        () => this.runRelays.delete(relay),
        () => this.runRelays.delete(relay),
      );

      const result = runScope
        .use(() => relay.then(() => run.result), { cancel: () => run.cancel("Plugin configuration is changing") })
        .finally(async () => {
          if (this.activeRunScope === runScope) this.activeRunScope = undefined;
          await runScope!.close();
          await Promise.all(this.pendingStateWrites);
        })
        .then(async (value) => {
          await this.session.saveBranchPosition(run.id);
          return value;
        });
      const wrapped: AgentRun = {
        id: run.id,
        result,
        ...omitUndefined({ traceContext: run.traceContext }),
        cancel: (reason?: string) => run.cancel(reason),
      };
      this.currentRun = wrapped;
      void result.then(
        () => this.clearCurrentRun(wrapped),
        () => this.clearCurrentRun(wrapped),
      );
      void result.catch(() => undefined);
      return wrapped;
    } catch (error) {
      rejectBarrier?.(error);
      this.runStartBarrier = undefined;
      acquiredRun?.cancel("Agent Run initialization failed");
      await acquiredRun?.result.catch(() => undefined);
      if (this.activeRunScope === runScope) this.activeRunScope = undefined;
      try {
        await runScope?.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Agent Run initialization and cleanup failed", {
          cause: error,
        });
      }
      this.throwIfClosed();
      throw error;
    } finally {
      this.starting = false;
      this.startingRun = undefined;
      this.startingController = undefined;
      finishStart();
      this.currentStart = undefined;
    }
  }

  /** @experimental */
  getService<T>(service: ServiceToken<T>): T {
    this.throwIfClosed();
    return this.hookScope().get(service);
  }

  /** @experimental */
  getOptionalService<T>(service: ServiceToken<T>): T | undefined {
    this.throwIfClosed();
    const scope = this.hookScope();
    return scope.provides(service) ? scope.get(service) : undefined;
  }

  /** @experimental */
  updatePlugins(plugins: readonly AnyPlugin[], options: PluginUpdateOptions = {}): Promise<void> {
    this.throwIfClosed();
    this.changingPlugins = true;
    this.pendingPluginChanges += 1;
    const operation = this.pluginChangeTail.then(async () => {
      if (this.closed) throw new Error("Agent application is closed");
      if (options.cancelActive === true) this.cancel("Plugin configuration is changing");
      await this.currentStart;
      if (options.cancelActive === true) this.cancel("Plugin configuration is changing");
      await this.currentRun?.result.catch(() => undefined);
      await this.activeCompaction?.result.catch(() => undefined);
      let reconfigured = false;
      let replacement: AgentRuntime | undefined;
      try {
        this.validatePlugins(plugins);
        reconfigured = true;
        await this.session.suspendRuntime();
        const state = await this.session.getRuntimeInfo();
        await this.reconfigurePlugins(plugins, options);
        replacement = await this.createRuntime(state.messages, state.info);
        await this.session.replaceRuntime(replacement);
        this.contextController?.setAutoCompactionSink?.(undefined);
        this.contextController?.setAutoCompactionFailureSink?.(undefined);
        this.contextController = this.readContextController();
        this.connectCompactionSinks();
        await this.sessionScope.observe(applicationHooks.created, { sessionId: this.sessionId }, this.hookContext());
        this.validateToolCatalog();
        this.pluginFailure = undefined;
      } catch (error) {
        if (reconfigured || !this.applicationScope.isReady || !this.sessionScope.isReady) this.pluginFailure = error;
        throw error;
      }
    });
    this.pluginChangeTail = operation.then(
      () => {
        this.pendingPluginChanges -= 1;
        this.changingPlugins = this.pendingPluginChanges > 0;
      },
      () => {
        this.pendingPluginChanges -= 1;
        this.changingPlugins = this.pendingPluginChanges > 0;
      },
    );
    return operation;
  }

  private async prepareInput(value: InputHook, signal?: AbortSignal): Promise<InputHook> {
    return prepareInput(
      value,
      () => this.hookScope(),
      () => this.hookContext(signal),
    );
  }

  private hookScope(): ApplicationPluginScope {
    return this.activeRunScope ?? this.sessionScope;
  }

  private hookContext(signal = new AbortController().signal): HookContext {
    return omitUndefined({
      signal: AbortSignal.any([
        signal,
        this.lifecycleController.signal,
        ...(this.startingController === undefined ? [] : [this.startingController.signal]),
      ]),
      sessionId: this.sessionId,
      runId: this.currentRun?.id,
    });
  }

  private connectCompactionSinks(): void {
    this.contextController?.setAutoCompactionSink?.((result, options) =>
      recordAutomaticCompaction(
        result,
        options,
        this.session,
        () => this.contextController,
        () => this.hookScope(),
        () => this.hookContext(options.signal),
        (event) => this.eventQueue.push(event),
      ),
    );
    this.contextController?.setAutoCompactionFailureSink?.((failure) =>
      recordAutomaticCompactionFailure(failure, this.hookScope(), this.hookContext(), (event) =>
        this.eventQueue.push(event),
      ),
    );
  }

  /** @experimental */
  cancel(reason = "Cancelled by user"): boolean {
    if (this.startingController !== undefined) {
      this.startingController.abort(new Error(reason));
      this.startingRun?.cancel(reason);
      return true;
    }
    if (this.currentRun !== undefined) {
      this.currentRun.cancel(reason);
      return true;
    }
    if (this.activeCompaction !== undefined) {
      this.activeCompaction.controller.abort(reason);
      return true;
    }
    return false;
  }

  /** @experimental */
  resolveApproval(requestId: string, decision: ApprovalDecision, options?: ApprovalResolveOptions): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.resolve(requestId, decision, options);
  }

  /** @experimental */
  listPermissionRules(scopeId?: string): Promise<readonly PersistentPermissionRule[]> {
    this.throwIfClosed();
    return this.permissions.listRules(scopeId);
  }

  /** @experimental */
  createPermissionRule(
    check: PermissionCheck,
    options: CreatePermissionRuleOptions,
  ): Promise<PersistentPermissionRule> {
    this.throwIfClosed();
    return this.permissions.createRule(check, options);
  }

  /** @experimental */
  createPermissionRuleFrom(sourceId: string, options: CreatePermissionRuleOptions): Promise<PersistentPermissionRule> {
    this.throwIfClosed();
    return this.permissions.createRuleFrom(sourceId, options);
  }

  /** @experimental */
  revokePermissionRule(id: string): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.revokeRule(id);
  }

  /** @public */
  history(): Promise<readonly SessionEvent[]> {
    return this.session.history();
  }

  /** @experimental */
  branchPositions(): Promise<readonly SessionBranchPosition[]> {
    return this.session.branchPositions();
  }

  /** @experimental */
  async saveBranchPosition(
    runId: string,
    options: import("../session/index.js").SessionBranchCompletionOptions = {},
  ): Promise<void> {
    if (this.isRunning) throw new Error("Branch positions require a settled application Run");
    await Promise.all(this.pendingStateWrites);
    await this.session.saveBranchPosition(runId, options);
  }

  /** @experimental */
  queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
    return this.session.queryHistory(query);
  }

  /** @experimental */
  listModelRequests(options: { afterSeq?: number; limit?: number } = {}) {
    return this.session.listModelRequests(options);
  }

  /** @experimental */
  getModelRequest(modelCallId: string) {
    return this.session.getModelRequest(modelCallId);
  }

  /** @experimental */
  async inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.contextController?.inspect();
  }

  /** @experimental */
  async compactContext(strategy = this.readCompactionStrategy()): Promise<ContextCompactionResult> {
    this.throwIfClosed();
    assertCompactionAvailable(this.isRunning, this.contextController);

    const active = startCompaction(
      strategy,
      this.session,
      this.sessionScope,
      (signal) => this.hookContext(signal),
      () => this.contextController!,
      this.tracer,
    );
    this.activeCompaction = active;
    return awaitCompaction(active, () => {
      if (this.activeCompaction === active) this.activeCompaction = undefined;
    });
  }

  /** @public */
  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    const cleanup = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      await cleanup(() =>
        this.sessionScope.observe(applicationHooks.beforeClose, { sessionId: this.sessionId }, this.hookContext()),
      );
      this.lifecycleController.abort(this.closeReason);
      this.startingRun?.cancel(this.closeReason);
      await this.startingRun?.result.catch(() => undefined);
      const active = this.currentRun;
      active?.cancel(this.closeReason);
      await active?.result.catch(() => undefined);
      const compaction = this.activeCompaction;
      compaction?.controller.abort(this.closeReason);
      await compaction?.result.catch(() => undefined);
      await cleanup(() => this.permissions.close(this.closeReason));
      await cleanup(async () => {
        await Promise.all([...this.runRelays]);
      });
      await cleanup(() => this.permissionRelay);
      await cleanup(() => this.pluginChangeTail);
      await cleanup(() => this.session.closeRuntime());
      await cleanup(() =>
        this.sessionScope.observe(applicationHooks.closed, { sessionId: this.sessionId }, this.hookContext()),
      );
      await cleanup(() => this.pluginHost.close());
    } finally {
      this.stateRecordingClosed = true;
      const stateWrites = await Promise.allSettled(this.pendingStateWrites);
      for (const result of stateWrites) if (result.status === "rejected") errors.push(result.reason);
      this.contextController?.setAutoCompactionSink?.(undefined);
      this.contextController?.setAutoCompactionFailureSink?.(undefined);
      this.eventQueue.close();
    }
    if (errors.length > 0) throw new AggregateError(errors, "Agent application cleanup failed");
  }

  private clearCurrentRun(run: AgentRun): void {
    if (this.currentRun === run) this.currentRun = undefined;
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("Agent application is closed");
  }
}

function assertSessionInputOptions(options: { readonly stepInputSource?: unknown }): void {
  if (options.stepInputSource !== undefined)
    throw new TypeError("Session manages step input through steer(); custom stepInputSource is unsupported");
}
