import {
  type ContextBudget,
  type ContextCompactionFailure,
  type ContextCompactionOptions,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextController,
  type ContextFactory,
  type ContextInspection,
  ModelContextCompactionStrategy,
} from "@may/context";
import {
  AsyncEventQueue,
  directToolExecutor,
  endTraceSpan,
  HookExecutionError,
  isStreamingMayEvent,
  RUNTIME_HOOKS,
  serializeError,
  startTraceSpan,
  ToolRegistry,
  traceError,
  type Message,
  type Model,
  type RunHandle,
  type RunBudget,
  type Tool,
  type ToolExecutor,
  type ToolScheduler,
  type TraceAttributes,
  type Tracer,
  type AgentRuntime,
  type HookContext,
  type HookDispatcher,
  type MayOptions,
} from "@may/core";
import { randomUUID } from "node:crypto";
import { PluginHost, type AnyPlugin, type PluginHostOptions, type ServiceToken } from "@may/plugin";
import { services, type ContextOptions } from "@may/plugin-services";
import { createModelPlugin } from "@may/plugin-models";
import { createContextPlugin, createToolsPlugin } from "@may/plugin-runtime";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { createSkillsPlugin } from "@may/plugin-skills";
import {
  PermissionToolExecutor,
  type ApprovalDecision,
  type ApprovalResolveOptions,
  type CreatePermissionRuleOptions,
  type PermissionCheck,
  type PermissionPolicy,
  type PermissionRuleStore,
  type PersistentPermissionRule,
} from "@may/permissions";
import {
  Session,
  createSessionId,
  type SessionContinueOptions,
  type SessionEvent,
  type SessionHistoryPage,
  type SessionHistoryQuery,
  type SessionRuntimeInfo,
  type SessionBranchPosition,
  type SessionSteerOptions,
  type SessionSteeringInput,
  type SessionStore,
  type SessionSubmitOptions,
  type SessionToolPresentation,
} from "@may/session";
import {
  createSessionHistoryTool,
  createSessionHistoryRetrievalTools,
  type SessionHistoryToolOptions,
} from "@may/session-tools";

import type { SteerableAgentController } from "./controller.js";
import { SkillRegistry, SkillSession, SKILL_STATE_KEY } from "@may/skills";
import type { AgentApplicationEvent, AgentRun } from "./events.js";
import { APPLICATION_HOOKS, applicationHooks, type InputHook } from "./hooks.js";
import {
  applicationServices,
  defaultRuntimePlugin,
  applicationInfrastructurePlugin,
  createCompositionPlugin,
  PLUGIN_STATE_KEY,
  readApplicationPluginState,
  type ApplicationPluginState,
  type PluginUpdateOptions,
} from "./plugins.js";

type ApplicationPluginScope = Awaited<ReturnType<PluginHost["createScope"]>>;

export interface AgentToolPresentation {
  readonly kind: string;
  readonly version: number;
  readonly data: unknown;
}

export interface AgentApplicationOptions {
  readonly model?: Model;
  readonly store: SessionStore;
  readonly permissionPolicy?: PermissionPolicy;
  readonly permissionRuleStore?: PermissionRuleStore;
  readonly plugins?: readonly AnyPlugin[];
  readonly pluginHookTimeoutMs?: number;
  readonly onPluginHookError?: PluginHostOptions["onHookError"];
  readonly tools?: Iterable<Tool>;
  /** Additional host catalog captured per Run; static tools remain fixed. */
  readonly toolSource?: () => Iterable<Tool>;
  /** Trusted host routing labels. The application supplies its own sessionId. */
  readonly toolScope?: Readonly<Record<string, string>>;
  readonly toolExecutor?: ToolExecutor;
  readonly toolScheduler?: ToolScheduler;
  readonly tracer?: Tracer;
  /** Content-free attributes attached to every Run opened by this application. */
  readonly traceAttributes?: TraceAttributes;
  readonly instructions?: string;
  readonly skills?: SkillRegistry;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly fork?: AgentApplicationFork;
  readonly forkStateKeys?: readonly string[];
  readonly forkPluginIds?: readonly string[];
  readonly forkStateTransform?: (key: string, value: unknown) => unknown;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  /** Default strategy used by explicit compaction and by the context itself. */
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Include the model-native compactor in the automatic chain, when present. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly responseFormat?: import("@may/core").ModelResponseFormat;
  /** Add the bounded session_history tool with these optional limits. */
  readonly sessionHistory?: false | (Omit<SessionHistoryToolOptions, "source"> & {
    /** Also expose bounded content search and chunked record reads. */
    readonly retrieval?: boolean;
  });
  /**
   * Produce durable, model-invisible display metadata before permission policy
   * evaluation. Coding diffs are one possible use; the application owns data.
   */
  readonly createToolPresentation?: (
    check: PermissionCheck,
  ) => AgentToolPresentation | undefined | Promise<AgentToolPresentation | undefined>;
  /** Validate metadata after a session is created or resumed. */
  readonly validateSession?: (
    metadata: Readonly<Record<string, unknown>> | undefined,
  ) => void | Promise<void>;
  readonly closeReason?: string;
}

export interface AgentApplicationFork {
  readonly sessionId: string;
  readonly positionSeq: number;
}

interface ActiveCompaction {
  readonly controller: AbortController;
  readonly result: Promise<ContextCompactionResult>;
}

/**
 * Reusable, headless lifecycle for one durable May agent session.
 *
 * Product composition (tools, prompts, permission policy and presentation data)
 * is injected; ordering, cancellation, event relays and compaction persistence
 * live here once for every application.
 */
export class AgentApplication implements SteerableAgentController {
  readonly events: AsyncIterable<AgentApplicationEvent>;
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;

  private readonly session: Session;
  private readonly permissions: PermissionToolExecutor;
  private contextController: ContextController | undefined;
  private readonly readCompactionStrategy: () => ContextCompactionStrategy | undefined;
  private readonly closeReason: string;
  private readonly tracer: Tracer | undefined;
  private readonly eventQueue = new AsyncEventQueue<AgentApplicationEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) =>
      value.type === "run.event" && isStreamingMayEvent(value.event),
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
    this.permissionRelay = this.relayPermissionEvents();
  }

  static async open(options: AgentApplicationOptions): Promise<AgentApplication> {
    const sessionId = options.sessionId ?? createSessionId();
    if (options.resume === true && options.sessionId === undefined) throw new Error("sessionId is required when resuming a session");
    if (options.resume === true && options.fork !== undefined) throw new Error("Session resume and fork cannot be combined");
    const forkPluginIds = ["may.skills", ...(options.forkPluginIds ?? []), ...(options.plugins ?? [])
      .filter((plugin) => plugin.provides?.some((service) => service.id === applicationServices.skills.id && service.scope === applicationServices.skills.scope))
      .map((plugin) => plugin.id)];
    const transformForkState = (key: string, value: unknown): unknown => {
      const selected = key === PLUGIN_STATE_KEY ? filterForkPluginState(readApplicationPluginState(value), forkPluginIds) : value;
      return options.forkStateTransform === undefined ? selected : options.forkStateTransform(key, selected);
    };
    let pluginState = readApplicationPluginState(undefined);
    if (options.resume === true || options.fork !== undefined) {
      const history = options.fork === undefined ? await options.store.read(sessionId) :
        await inspectForkHistory(options.store, options.fork);
      const event = [...history].reverse().find((event) => event.type === "state.updated" && event.key === PLUGIN_STATE_KEY);
      if (event?.type === "state.updated") pluginState = readApplicationPluginState(event.value);
      if (options.fork !== undefined) pluginState = readApplicationPluginState(transformForkState(PLUGIN_STATE_KEY, pluginState));
    }
    let application: AgentApplication | undefined;
    let contextController: ContextController | undefined;
    let historySource: Session | undefined;
    let pendingPluginState = false;
    let pluginStateTail: Promise<void> = Promise.resolve();
    const persistPluginState = (scope: "application" | "session", snapshot: ApplicationPluginState["application"]) => {
      const operation = pluginStateTail.then(async () => {
        const candidate = { ...pluginState, [scope]: snapshot };
        if (historySource === undefined) pendingPluginState = true;
        else await historySource.recordState(PLUGIN_STATE_KEY, candidate);
        if (scope === "application") {
          const owner = configuredPlugins.find((plugin) => plugin.provides?.some((service) => service.id === applicationServices.skills.id && service.scope === applicationServices.skills.scope));
          if (owner !== undefined && JSON.stringify(pluginState.application[owner.id]?.value) !== JSON.stringify(snapshot[owner.id]?.value)) {
            contextController?.invalidateMeasurement?.();
          }
        }
        pluginState = candidate;
      });
      pluginStateTail = operation.catch(() => undefined);
      return operation;
    };
    const access = { get() {
      if (application === undefined) throw new Error("AgentApplication is unavailable before application.created");
      return application;
    } };
    const composePlugins = (plugins: readonly AnyPlugin[]) => composeApplicationPlugins(plugins, options, access, () => options.instructions ?? "");
    let configuredPlugins = composePlugins(options.plugins ?? []);
    const pluginHost = await PluginHost.create({
      plugins: configuredPlugins,
      hooks: [...RUNTIME_HOOKS, ...APPLICATION_HOOKS],
      ...(options.pluginHookTimeoutMs === undefined ? {} : { timeoutMs: options.pluginHookTimeoutMs }),
      ...(options.onPluginHookError === undefined ? {} : { onHookError: options.onPluginHookError }),
    });
    let applicationScope: ApplicationPluginScope;
    let sessionScope: ApplicationPluginScope;
    try {
      applicationScope = await pluginHost.createScope("application", {
        id: sessionId,
        state: pluginState.application,
        onStateChange: (snapshot) => persistPluginState("application", snapshot),
      });
      sessionScope = await applicationScope.createScope("session", {
        id: sessionId,
        state: pluginState.session,
        onStateChange: (snapshot) => persistPluginState("session", snapshot),
      });
      const opening = await sessionScope.transform(applicationHooks.beforeCreate, {
        sessionId,
        resume: options.resume === true,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
        ...(options.contextMetadata === undefined ? {} : { contextMetadata: options.contextMetadata }),
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      }, { signal: new AbortController().signal, sessionId });
      if (opening.sessionId !== sessionId || opening.resume !== (options.resume === true)) throw new Error("Application identity cannot be modified by a Hook");
      options = { ...options, ...opening };
      sessionScope.get(applicationServices.model);
      sessionScope.get(applicationServices.permissionPolicy);
    } catch (error) {
      try { await pluginHost.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Application plugin initialization and cleanup failed", { cause: error }); }
      throw error;
    }
    const hooks: HookDispatcher = {
      transform: (hook, value, context) => (application?.activeRunScope ?? sessionScope).transform(hook, value, { ...context, sessionId }),
      observe: async (hook, value, context) => {
        if (hook.name === "run.before") await application?.runStartBarrier;
        await (application?.activeRunScope ?? sessionScope).observe(hook, value, { ...context, sessionId });
      },
    };
    let cleanupPermissions: PermissionToolExecutor | undefined;
    let pendingRuntime: AgentRuntime | undefined;
    let openedSession: Session | undefined;
    let openSpan: ReturnType<typeof startTraceSpan>;
    try {
    const configuredTools = new ToolRegistry();
    if (options.sessionHistory !== false && options.sessionHistory !== undefined) {
      const historyTool = createSessionHistoryTool({
        ...options.sessionHistory,
        source: () => {
          if (historySource === undefined) {
            throw new Error("Session history is unavailable before session creation");
          }
          return historySource;
        },
      });
      if (configuredTools.has(historyTool.name)) {
        throw new Error(`Tool name "${historyTool.name}" is reserved by AgentApplication`);
      }
      configuredTools.register(historyTool);
      for (const tool of options.sessionHistory.retrieval === true
        ? createSessionHistoryRetrievalTools({ source: () => historySource! }) : []) {
        if (configuredTools.has(tool.name)) throw new Error(`Tool name "${tool.name}" is reserved by AgentApplication`);
        configuredTools.register(tool);
      }
    }

    const validateToolCatalog = () => {
      ToolRegistry.compose(configuredTools, sessionScope.get(applicationServices.toolSources).snapshot(),
        sessionScope.provides(applicationServices.tools) ? sessionScope.get(applicationServices.tools) : []);
    };
    const tracer: Tracer = {
      startSpan: (name, traceOptions) => sessionScope.get(applicationServices.tracer).startSpan(name, traceOptions),
      recordMetric: record => {
        if (sessionScope.provides(applicationServices.tracer)) sessionScope.get(applicationServices.tracer).recordMetric?.(record);
      },
    };
    const permissions = new PermissionToolExecutor({
      ...(options.permissionRuleStore === undefined ? {} : { ruleStore: options.permissionRuleStore }),
      beforeCheck: async (check) => {
        const presentation = await options.createToolPresentation?.(check);
        if (presentation !== undefined) {
          if (application === undefined) {
            throw new Error("Tool presentation requested before session creation");
          }
          await application.recordToolPresentation(check, presentation);
        }
      },
      policy: (check) => sessionScope.get(applicationServices.permissionPolicy)(check),
      executor: { execute: (execution) => (sessionScope.provides(applicationServices.toolExecutor)
        ? sessionScope.get(applicationServices.toolExecutor) : directToolExecutor).execute(execution) },
      tracer,
    });
    cleanupPermissions = permissions;

    let contextOptions: ContextOptions = {};
    const createRuntime = async (
      messages: Message[] = [],
      runtimeInfo: SessionRuntimeInfo = {},
    ) => {
      const model = sessionScope.get(applicationServices.modelWrappers).apply(sessionScope.get(applicationServices.model));
      const contextFactory = sessionScope.get(applicationServices.contextWrappers).apply(sessionScope.get(applicationServices.contextFactory));
      const configuredContext = sessionScope.provides(applicationServices.contextOptions) ? sessionScope.get(applicationServices.contextOptions) : {};
      contextOptions = typeof configuredContext === "function" ? configuredContext(model) : configuredContext;
      if (typeof contextOptions !== "object" || contextOptions === null) throw new TypeError("Context options source must return an object");
      const nativeCompactionStrategy = contextOptions.providerNativeAutoCompaction === true && model.contextCompactor !== undefined
        ? new ModelContextCompactionStrategy(model.contextCompactor) : undefined;
      const autoCompactionStrategies = contextOptions.autoCompactionStrategies ??
        (nativeCompactionStrategy === undefined ? [] : [nativeCompactionStrategy]);
      const hookStrategy = (strategy: ContextCompactionStrategy): ContextCompactionStrategy => ({
        name: strategy.name,
        async compact(snapshot, compactionOptions = {}) {
          const context: HookContext = { signal: compactionOptions.signal ?? new AbortController().signal, sessionId,
            ...(compactionOptions.runId === undefined ? {} : { runId: compactionOptions.runId }),
            ...(compactionOptions.step === undefined ? {} : { step: compactionOptions.step }) };
          let selected;
          try {
            selected = await hooks.transform(applicationHooks.compactionBefore, { strategy: strategy.name, automatic: true }, context);
          } catch (error) { throw new HookExecutionError(error, applicationHooks.compactionBefore.name); }
          const target = [strategy, ...autoCompactionStrategies, ...(contextOptions.compactionStrategy === undefined ? [] : [contextOptions.compactionStrategy])]
            .find((candidate) => candidate.name === selected.strategy);
          if (target === undefined || selected.automatic !== true) throw new HookExecutionError(new Error(`Unsupported compaction selection: ${selected.strategy}`), applicationHooks.compactionBefore.name);
          return target.compact(snapshot, compactionOptions);
        },
      });
      const skills = sessionScope.provides(applicationServices.skills) ? sessionScope.get(applicationServices.skills) : undefined;
      if (skills !== undefined && skills.listActive().length === 0) skills.restore(runtimeInfo.state?.[SKILL_STATE_KEY]);
      let measuredInstructions: string | undefined;
      let instructionController: ContextController | undefined;
      const instructionsSource = () => {
        const current = sessionScope.get(applicationServices.instructionSources).snapshot();
        if (measuredInstructions !== undefined && current !== measuredInstructions) {
          instructionController?.invalidateMeasurement?.();
        }
        measuredInstructions = current;
        return current;
      };
      const contextMetadata = options.contextMetadata ?? options.metadata;
      const managedContext = await contextFactory.create({
        instructions: instructionsSource(), instructionsSource,
        messages,
        ...(contextMetadata === undefined
          ? {}
          : { metadata: contextMetadata }),
        ...(contextOptions.budget === undefined
          ? {}
          : { budget: contextOptions.budget }),
        ...(runtimeInfo.latestModelMeasurement === undefined || (skills !== undefined && (skills.registry.list().length > 0 || skills.listActive().length > 0))
          ? {}
          : { measurement: runtimeInfo.latestModelMeasurement }),
        ...(contextOptions.compactionStrategy === undefined
          ? {}
          : { compactionStrategy: contextOptions.compactionStrategy }),
        autoCompactionStrategies: autoCompactionStrategies.map(hookStrategy),
      });
      contextController = managedContext.controller;
      instructionController = managedContext.controller;
      const modelInfo = sessionScope.provides(applicationServices.modelInfo) ? sessionScope.get(applicationServices.modelInfo) : undefined;
      const runtimeTraceAttributes: Record<string, import("@may/core").TraceAttributeValue> = { ...(options.traceAttributes ?? {}), "may.session.id": sessionId };
      for (const key of ["may.model.provider", "may.model.name", "may.model.adapter", "may.model.profile"]) delete runtimeTraceAttributes[key];
      if (modelInfo !== undefined) {
        Object.assign(runtimeTraceAttributes, {
          "may.model.provider": modelInfo.provider,
          "may.model.name": modelInfo.model,
          ...(modelInfo.adapter === undefined ? {} : { "may.model.adapter": modelInfo.adapter }),
          ...(modelInfo.profile === undefined ? {} : { "may.model.profile": modelInfo.profile }),
        });
      }
      const runtimeOptions: MayOptions = {
        model,
        tools: configuredTools,
        toolScope: () => ({ ...options.toolScope, sessionId }),
        toolSource: () => [...sessionScope.get(applicationServices.toolSources).snapshot(), ...(sessionScope.provides(applicationServices.tools) ? sessionScope.get(applicationServices.tools) : [])],
        context: managedContext.context,
        hooks,
        toolExecutor: permissions,
        tracer,
        ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
        ...(Object.keys(runtimeTraceAttributes).length === 0
          ? {}
          : { traceAttributes: runtimeTraceAttributes }),
        ...(sessionScope.provides(applicationServices.toolScheduler)
          ? { toolScheduler: sessionScope.get(applicationServices.toolScheduler) } : {}),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
      };
      validateToolCatalog();
      const runtime = await sessionScope.get(applicationServices.runtimeFactory)(runtimeOptions);
      if (openedSession === undefined) pendingRuntime = runtime;
      const supportedHooks = new Set(runtime.supportedHooks?.map((hook) => hook.name) ?? []);
      for (const plugin of configuredPlugins) {
        for (const required of plugin.requiresHooks ?? []) {
          if (RUNTIME_HOOKS.some((hook) => hook.name === required.name) && !supportedHooks.has(required.name)) {
            await runtime.close?.();
            pendingRuntime = undefined;
            throw new Error(`Runtime does not support Hook "${required.name}" required by "${plugin.id}"`);
          }
        }
      }
      return runtime;
    };

    openSpan = startTraceSpan(tracer, "may.application.open", {
      attributes: {
        ...(options.traceAttributes ?? {}),
        "may.application.resume": options.resume === true,
        ...(options.sessionId === undefined
          ? {}
          : { "may.session.id": options.sessionId }),
      },
    });
      const session = options.fork !== undefined
        ? await Session.fork({ sourceId: options.fork.sessionId, positionSeq: options.fork.positionSeq,
            id: sessionId, store: options.store, deferBranchPositions: true, deferForkReady: true,
            stateKeys: [SKILL_STATE_KEY, PLUGIN_STATE_KEY, ...(options.forkStateKeys ?? [])],
            transformState: transformForkState,
            ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
            createRuntime: async (messages, info) => {
              const runtime = await createRuntime(messages, info); pendingRuntime = undefined; return runtime;
            } })
        : options.resume === true
        ? await resumeSession(options, async (messages, info) => {
            const runtime = await createRuntime(messages, info);
            pendingRuntime = undefined;
            return runtime;
          })
        : await Session.create({
            runtime: await createRuntime(),
            store: options.store,
            deferBranchPositions: true,
            ...(options.metadata === undefined
              ? {}
              : { metadata: { ...options.metadata } }),
            ...(options.sessionId === undefined ? {} : { id: options.sessionId }),
          });
      historySource = session;
      openedSession = session;
      pendingRuntime = undefined;
      try { await options.validateSession?.(session.metadata); }
      catch (error) {
        if (options.resume !== true && options.fork === undefined) await options.store?.delete?.(session.id);
        throw error;
      }
      permissions.setEventSink(async (event) => {
        await session.recordPermissionEvent(event);
        const payload = event.type === "approval.requested" ? {
          ...event,
          request: { ...event.request, context: {
            runId: event.request.context.runId,
            step: event.request.context.step,
            toolCallId: event.request.context.toolCallId,
            idempotencyKey: event.request.context.idempotencyKey,
            ...(event.request.context.scope === undefined ? {} : { scope: event.request.context.scope }),
            ...(event.request.context.traceContext === undefined ? {} : { traceContext: event.request.context.traceContext }),
          } },
        } : event;
        if (event.type === "approval.requested" || event.type === "approval.resolved" || event.type === "approval.cancelled") {
          await hooks.observe(event.type === "approval.requested" ? applicationHooks.approvalRequested : applicationHooks.approvalResolved,
            payload, { signal: new AbortController().signal, sessionId });
        }
      });
      application = new AgentApplication(
        session,
        permissions,
        contextController,
        () => contextOptions.compactionStrategy,
        options.closeReason ?? "Agent application is closing",
        tracer,
        pluginHost,
        applicationScope,
        sessionScope,
        createRuntime,
        () => contextController,
        async (plugins, changeOptions) => {
          const next = composePlugins(plugins);
          await applicationScope.replacePlugins(next, changeOptions);
          configuredPlugins = next;
        },
        (plugins) => applicationScope.validatePlugins(composePlugins(plugins)),
        validateToolCatalog,
      );
      if (pendingPluginState || Object.keys(applicationScope.snapshotState()).length > 0 || Object.keys(sessionScope.snapshotState()).length > 0) {
        await session.recordState(PLUGIN_STATE_KEY, {
          version: 1,
          application: applicationScope.snapshotState(),
          session: sessionScope.snapshotState(),
        });
      }
      contextController?.setAutoCompactionSink?.((result, compactionOptions) =>
        application!.recordAutomaticCompaction(result, compactionOptions)
      );
      contextController?.setAutoCompactionFailureSink?.((failure) =>
        application!.recordAutomaticCompactionFailure(failure)
      );
      await sessionScope.observe(applicationHooks.created, { sessionId: session.id }, application.hookContext());
      validateToolCatalog();
      if (options.fork !== undefined) {
        await Promise.all(application.pendingStateWrites);
        await session.saveForkReady();
      }
      endTraceSpan(openSpan, {
        status: "ok",
        attributes: { "may.session.id": session.id },
      });
      return application;
    } catch (error) {
      endTraceSpan(openSpan, { status: "error", error: traceError(error) });
      const failures: unknown[] = [error];
      const cleanup = async (operation: () => void | Promise<void>) => {
        try { await operation(); }
        catch (cleanupError) { failures.push(cleanupError); }
      };
      if (application !== undefined) await cleanup(() => application!.close());
      else {
        await cleanup(() => cleanupPermissions?.close());
        await cleanup(() => openedSession?.closeRuntime());
        await cleanup(() => pendingRuntime?.close?.());
        await cleanup(() => pluginHost.close());
      }
      if (failures.length > 1) throw new AggregateError(failures, "Agent application initialization and cleanup failed", { cause: error });
      throw error;
    }
  }

  get isRunning(): boolean {
    return this.starting || this.changingPlugins ||
      this.currentRun !== undefined ||
      this.activeCompaction !== undefined;
  }

  get skills(): SkillSession | undefined {
    return this.sessionScope.provides(applicationServices.skills) ? this.sessionScope.get(applicationServices.skills) : undefined;
  }

  /** Persist application-owned session memory; available during tool execution. */
  recordState(key: string, value: unknown): Promise<void> {
    if (this.stateRecordingClosed) throw new Error("Agent application is closed");
    const writing = this.session.recordState(key, value);
    this.pendingStateWrites.add(writing);
    void writing.then(() => this.pendingStateWrites.delete(writing), () => this.pendingStateWrites.delete(writing));
    return writing;
  }

  submit(options: SessionSubmitOptions): Promise<AgentRun> {
    assertSessionInputOptions(options);
    let input: InputHook;
    return this.startRun(async () => {
      input = await this.prepareInput({ input: options.input, ...(options.inputId === undefined ? {} : { inputId: options.inputId }) }, options.signal);
      return this.session.submit({ ...options, input: input.input, signal: this.hookContext(options.signal).signal,
        ...(input.inputId === undefined ? {} : { inputId: input.inputId }) });
    }, (run) => this.hookScope().observe(applicationHooks.inputSubmitted, { ...input, runId: run.id }, this.hookContext(options.signal)), options.signal);
  }

  async steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    this.throwIfClosed();
    if (this.starting || this.changingPlugins || this.activeCompaction !== undefined) throw new Error("Cannot steer while an agent operation is starting or compacting context");
    const input = await this.prepareInput({ input: options.input, steering: true, ...(options.inputId === undefined ? {} : { inputId: options.inputId }) });
    const result = await this.session.steer({ ...options, input: input.input, ...(input.inputId === undefined ? {} : { inputId: input.inputId }) });
    await this.hookScope().observe(applicationHooks.inputSubmitted, { ...input, inputId: result.inputId }, this.hookContext());
    return result;
  }

  listSteeringInputs(): readonly SessionSteeringInput[] {
    return this.session.listSteeringInputs();
  }

  cancelSteeringInputs(reason = "Cancelled by user"): Promise<void> {
    this.throwIfClosed();
    return this.session.cancelSteeringInputs(reason);
  }

  startSteeringInput(inputId: string, options: Omit<SessionSubmitOptions, "input" | "inputId"> = {}): Promise<AgentRun> {
    assertSessionInputOptions(options);
    return this.startRun(() => this.session.startSteeringInput(inputId, { ...options, signal: this.hookContext(options.signal).signal }), undefined, options.signal);
  }

  /** 在当前上下文中继续执行，沿用运行互斥和保存流程。 */
  continue(options: SessionContinueOptions = {}): Promise<AgentRun> {
    assertSessionInputOptions(options);
    return this.startRun(() => this.session.continue({ ...options, signal: this.hookContext(options.signal).signal }), undefined, options.signal);
  }

  listRecoveries() { return this.session.listRecoveries(); }

  async activateSkill(name: string) {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot activate a skill while an operation is active");
    if (!this.skills) throw new Error("Skills are disabled");
    this.starting = true;
    try { return await this.skills.activate(name); }
    finally { this.starting = false; }
  }

  async resolveRecovery(id: string, finding: string): Promise<void> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot resolve recovery while an operation is active");
    const result = await this.sessionScope.transform(applicationHooks.recoveryBefore, { id, finding }, this.hookContext());
    if (result.id !== id) throw new Error("Recovery identity cannot be changed by a Hook");
    await this.session.resolveRecovery(result.id, result.finding);
    await this.sessionScope.observe(applicationHooks.recoveryResolved, result, this.hookContext());
  }

  /** Retry the latest failed run without adding another user message. */
  retry(): Promise<AgentRun> {
    return this.startRun(async () => {
      if (!latestRunFailed(await this.session.history())) {
        throw new Error("The latest run did not fail; there is nothing to retry");
      }
      return this.session.continue({ signal: this.hookContext().signal });
    });
  }

  private async startRun(start: () => Promise<RunHandle>, afterStart?: (run: RunHandle) => Promise<void>, signal?: AbortSignal): Promise<AgentRun> {
    this.throwIfClosed();
    if (this.pluginFailure !== undefined) throw new Error("Plugin configuration is unavailable; update plugins before starting a Run", { cause: this.pluginFailure });
    if (this.isRunning) throw new Error("An agent operation is already active");

    this.starting = true;
    this.startingController = new AbortController();
    let finishStart!: () => void;
    this.currentStart = new Promise<void>((resolve) => { finishStart = resolve; });
    let runScope: ApplicationPluginScope | undefined;
    let acquiredRun: RunHandle | undefined;
    let releaseBarrier: (() => void) | undefined;
    let rejectBarrier: ((error: unknown) => void) | undefined;
    if (afterStart !== undefined) {
      this.runStartBarrier = new Promise<void>((resolve, reject) => { releaseBarrier = resolve; rejectBarrier = reject; });
      void this.runStartBarrier.catch(() => undefined);
    }
    try {
      runScope = await this.sessionScope.createScope("run", { id: `run-${randomUUID()}`, signal: this.hookContext(signal).signal });
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
      const relay = this.relayRunEvents(run.events);
      this.runRelays.add(relay);
      void relay.then(() => this.runRelays.delete(relay), () => this.runRelays.delete(relay));

      const result = runScope.use(() => relay.then(() => run.result), { cancel: () => run.cancel("Plugin configuration is changing") })
        .finally(async () => {
          if (this.activeRunScope === runScope) this.activeRunScope = undefined;
          await runScope!.close();
          await Promise.all(this.pendingStateWrites);
        }).then(async (value) => {
          await this.session.saveBranchPosition(run.id);
          return value;
        });
      const wrapped: AgentRun = {
        id: run.id,
        result,
        ...(run.traceContext === undefined
          ? {}
          : { traceContext: run.traceContext }),
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
      try { await runScope?.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Agent Run initialization and cleanup failed", { cause: error }); }
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

  getService<T>(service: ServiceToken<T>): T {
    this.throwIfClosed();
    return this.hookScope().get(service);
  }

  getOptionalService<T>(service: ServiceToken<T>): T | undefined {
    this.throwIfClosed();
    const scope = this.hookScope();
    return scope.provides(service) ? scope.get(service) : undefined;
  }

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
      () => { this.pendingPluginChanges -= 1; this.changingPlugins = this.pendingPluginChanges > 0; },
      () => { this.pendingPluginChanges -= 1; this.changingPlugins = this.pendingPluginChanges > 0; },
    );
    return operation;
  }

  private async prepareInput(value: InputHook, signal?: AbortSignal): Promise<InputHook> {
    await this.hookScope().observe(applicationHooks.inputReceived, value, this.hookContext(signal));
    const result = await this.hookScope().transform(applicationHooks.inputBeforeSubmit, value, this.hookContext(signal));
    if (result.inputId !== value.inputId || result.steering !== value.steering) {
      throw new HookExecutionError(new Error("Input identity and delivery mode cannot be modified"), applicationHooks.inputBeforeSubmit.name);
    }
    return result;
  }

  private hookScope(): ApplicationPluginScope {
    return this.activeRunScope ?? this.sessionScope;
  }

  private hookContext(signal = new AbortController().signal): HookContext {
    return { signal: AbortSignal.any([signal, this.lifecycleController.signal,
      ...(this.startingController === undefined ? [] : [this.startingController.signal])]), sessionId: this.sessionId,
      ...(this.currentRun === undefined ? {} : { runId: this.currentRun.id }) };
  }

  private connectCompactionSinks(): void {
    this.contextController?.setAutoCompactionSink?.((result, options) => this.recordAutomaticCompaction(result, options));
    this.contextController?.setAutoCompactionFailureSink?.((failure) => this.recordAutomaticCompactionFailure(failure));
  }

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

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: ApprovalResolveOptions,
  ): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.resolve(requestId, decision, options);
  }

  listPermissionRules(scopeId?: string): Promise<readonly PersistentPermissionRule[]> {
    this.throwIfClosed();
    return this.permissions.listRules(scopeId);
  }

  createPermissionRule(check: PermissionCheck, options: CreatePermissionRuleOptions): Promise<PersistentPermissionRule> {
    this.throwIfClosed();
    return this.permissions.createRule(check, options);
  }

  createPermissionRuleFrom(sourceId: string, options: CreatePermissionRuleOptions): Promise<PersistentPermissionRule> {
    this.throwIfClosed();
    return this.permissions.createRuleFrom(sourceId, options);
  }

  revokePermissionRule(id: string): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.revokeRule(id);
  }

  history(): Promise<readonly SessionEvent[]> {
    return this.session.history();
  }

  branchPositions(): Promise<readonly SessionBranchPosition[]> {
    return this.session.branchPositions();
  }

  async saveBranchPosition(runId: string, options: import("@may/session").SessionBranchCompletionOptions = {}): Promise<void> {
    if (this.isRunning) throw new Error("Branch positions require a settled application Run");
    await Promise.all(this.pendingStateWrites);
    await this.session.saveBranchPosition(runId, options);
  }

  queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
    return this.session.queryHistory(query);
  }

  async inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.contextController?.inspect();
  }

  async compactContext(
    strategy = this.readCompactionStrategy(),
  ): Promise<ContextCompactionResult> {
    this.throwIfClosed();
    if (this.isRunning) {
      throw new Error("Cannot compact context while an operation is active");
    }
    if (this.contextController?.compact === undefined) {
      throw new Error("Context compaction is not supported by the active context");
    }

    const controller = new AbortController();
    const span = startTraceSpan(this.tracer, "may.context.compact", {
      attributes: {
        "may.session.id": this.sessionId,
        ...(strategy === undefined
          ? {}
          : { "may.context.compaction.strategy": strategy.name }),
      },
    });
    const operation = this.performCompaction(strategy, controller.signal).then(
      (result) => {
        endTraceSpan(span, {
          status: "ok",
          attributes: {
            "may.context.compaction.strategy": result.strategy,
            "may.context.compaction.changed": result.changed,
            "may.context.before_message_count": result.before.messageCount,
            "may.context.after_message_count": result.after.messageCount,
            "may.context.before_estimated_tokens": result.before.estimatedTokens,
            "may.context.after_estimated_tokens": result.after.estimatedTokens,
          },
        });
        return result;
      },
      (error: unknown) => {
        endTraceSpan(span, {
          status: controller.signal.aborted ? "cancelled" : "error",
          error: traceError(error),
        });
        throw error;
      },
    );
    const active: ActiveCompaction = { controller, result: operation };
    this.activeCompaction = active;
    try {
      return await operation;
    } finally {
      if (this.activeCompaction === active) this.activeCompaction = undefined;
    }
  }

  private async performCompaction(
    strategy: ContextCompactionStrategy | undefined,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult> {
    try {
      const selection = await this.sessionScope.transform(applicationHooks.compactionBefore,
        { ...(strategy === undefined ? {} : { strategy: strategy.name }), automatic: false }, this.hookContext(signal));
      if (selection.strategy !== strategy?.name) throw new Error(`Unsupported compaction strategy: ${selection.strategy}`);
      const result = await this.contextController!.compact!(strategy, { signal });
      if (result.changed) {
        try {
          await this.persistCompaction(result);
          this.contextController!.commitCompaction?.(result);
        } catch (error) {
          await this.contextController!.rollbackCompaction?.(result);
          throw error;
        }
      }
      await this.sessionScope.observe(applicationHooks.compactionCompleted, { ...result, automatic: false }, this.hookContext(signal));
      return result;
    } catch (error) {
      await this.sessionScope.observe(applicationHooks.compactionFailed,
        { ...(strategy === undefined ? {} : { strategy: strategy.name }), automatic: false, error: serializeError(error) }, this.hookContext(signal));
      throw error;
    }
  }

  private async recordAutomaticCompaction(
    result: ContextCompactionResult,
    options: ContextCompactionOptions,
  ): Promise<void> {
    await this.persistCompaction(result, options);
    this.contextController?.commitCompaction?.(result);
    await this.hookScope().observe(applicationHooks.compactionCompleted, { ...result, automatic: true }, this.hookContext(options.signal));
    this.eventQueue.push({
      type: "context.compacted",
      strategy: result.strategy,
      before: result.before,
      after: result.after,
    });
  }

  private async recordAutomaticCompactionFailure(
    failure: ContextCompactionFailure,
  ): Promise<void> {
    await this.hookScope().observe(applicationHooks.compactionFailed,
      { strategy: failure.strategy, automatic: true, error: serializeError(failure.error) }, this.hookContext());
    this.eventQueue.push({
      type: "context.compaction.failed",
      strategy: failure.strategy,
      automatic: true,
      error: serializeError(failure.error),
      continuing: failure.continuing,
      before: failure.before,
    });
  }

  private persistCompaction(
    result: ContextCompactionResult,
    ordering?: Pick<ContextCompactionOptions, "runId" | "step">,
  ): Promise<void> {
    const afterRunStep = ordering?.runId === undefined || ordering.step === undefined
      ? undefined
      : { runId: ordering.runId, step: ordering.step };
    return this.session.recordContextCompaction(
      {
        strategy: result.strategy,
        messages: result.messages,
        beforeMessageCount: result.before.messageCount,
        afterMessageCount: result.after.messageCount,
        beforeEstimatedTokens: result.before.estimatedTokens,
        afterEstimatedTokens: result.after.estimatedTokens,
      },
      afterRunStep,
    );
  }

  private async recordToolPresentation(
    check: PermissionCheck,
    value: AgentToolPresentation,
  ): Promise<void> {
    const presentation: SessionToolPresentation = {
      runId: check.context.runId,
      step: check.context.step,
      toolCallId: check.context.toolCallId,
      kind: value.kind,
      version: value.version,
      data: value.data,
    };
    await this.session.recordToolPresentation(presentation);
    this.eventQueue.push({ type: "tool.presentation", presentation });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    const cleanup = async (operation: () => void | Promise<void>) => {
      try { await operation(); }
      catch (error) { errors.push(error); }
    };
    try {
      await cleanup(() => this.sessionScope.observe(applicationHooks.beforeClose, { sessionId: this.sessionId }, this.hookContext()));
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
      await cleanup(async () => { await Promise.all([...this.runRelays]); });
      await cleanup(() => this.permissionRelay);
      await cleanup(() => this.pluginChangeTail);
      await cleanup(() => this.session.closeRuntime());
      await cleanup(() => this.sessionScope.observe(applicationHooks.closed, { sessionId: this.sessionId }, this.hookContext()));
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

  private async relayRunEvents(events: AsyncIterable<import("@may/core").MayEvent>) {
    for await (const event of events) {
      if (event.type === "model.completed" && event.usage !== undefined) {
        this.contextController?.recordModelUsage?.(
          event.usage,
          event.contextMessageCount,
        );
      }
      this.eventQueue.push({ type: "run.event", event });
    }
  }

  private async relayPermissionEvents(): Promise<void> {
    for await (const event of this.permissions.events) {
      this.eventQueue.push({ type: "permission.event", event });
    }
  }

  private clearCurrentRun(run: AgentRun): void {
    if (this.currentRun === run) this.currentRun = undefined;
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("Agent application is closed");
  }
}

async function resumeSession(
  options: AgentApplicationOptions,
  createRuntime: (
    messages?: Message[],
    runtimeInfo?: SessionRuntimeInfo,
  ) => Promise<AgentRuntime>,
): Promise<Session> {
  if (options.sessionId === undefined) {
    throw new Error("sessionId is required when resuming a session");
  }
  return Session.resume({
    id: options.sessionId,
    store: options.store,
    deferBranchPositions: true,
    createRuntime: (messages, info) => createRuntime(messages, info),
  });
}

function composeApplicationPlugins(
  plugins: readonly AnyPlugin[],
  options: AgentApplicationOptions,
  access: { get(): AgentApplication },
  instructions: () => string,
): readonly AnyPlugin[] {
  const composition: AnyPlugin[] = [...plugins];
  const provided = (service: ServiceToken) => composition.some((plugin) => plugin.provides?.some((token) => token.id === service.id && token.scope === service.scope));
  const valuePlugin = <T>(service: ServiceToken<T>, value: T): AnyPlugin => ({
    id: `may.supplied.${service.id}`, version: "1.0.0", provides: [service],
    setup(context) { context.provide(service, value); },
  });
  composition.push(valuePlugin(applicationServices.sessionStore, options.store));
  composition.push(valuePlugin(applicationServices.application, access));
  if (options.model !== undefined) composition.push(createModelPlugin({ create: () => options.model! }));
  if (options.permissionPolicy !== undefined) composition.push(createPermissionPlugin({ create: () => options.permissionPolicy! }));
  else if (!provided(applicationServices.permissionPolicy)) composition.push(createPermissionPlugin({ create: () => () => { throw new TypeError("permissionPolicy is required for tool execution"); } }));
  if (options.contextFactory !== undefined || !provided(applicationServices.contextFactory)) {
    composition.push(createContextPlugin({ ...(options.contextFactory === undefined ? {} : { create: () => options.contextFactory! }) }));
  }
  if ([options.contextBudget, options.compactionStrategy, options.autoCompactionStrategies, options.providerNativeAutoCompaction].some((value) => value !== undefined)) {
    composition.push(valuePlugin(applicationServices.contextOptions, {
      ...(options.contextBudget === undefined ? {} : { budget: options.contextBudget }),
      ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
      ...(options.autoCompactionStrategies === undefined ? {} : { autoCompactionStrategies: options.autoCompactionStrategies }),
      ...(options.providerNativeAutoCompaction === undefined ? {} : { providerNativeAutoCompaction: options.providerNativeAutoCompaction }),
    }));
  }
  if (options.toolExecutor !== undefined) composition.push(valuePlugin(applicationServices.toolExecutor, options.toolExecutor));
  if (options.toolScheduler !== undefined) composition.push(valuePlugin(applicationServices.toolScheduler, options.toolScheduler));
  if (options.tracer !== undefined) composition.push(valuePlugin(applicationServices.tracer, options.tracer));
  if (options.skills !== undefined) composition.push(createSkillsPlugin({ create: () => options.skills! }));
  if (options.tools !== undefined || options.toolSource !== undefined) {
    const tools = new ToolRegistry(options.tools);
    composition.push(createToolsPlugin({ id: "may.supplied.tools", order: -100,
      create: () => () => [...tools, ...(options.toolSource?.() ?? [])],
    }));
  }
  composition.push({ id: "may.supplied.instructions", version: "1.0.0", requires: [{ service: applicationServices.instructionSources }],
    setup(context) { context.defer(context.get(applicationServices.instructionSources).add(instructions, {
      id: context.pluginId, order: -100, pluginOrder: context.pluginOrder,
    })); },
  });
  if (!provided(applicationServices.runtimeFactory)) composition.push(defaultRuntimePlugin);
  composition.push(createCompositionPlugin(composition), applicationInfrastructurePlugin);
  return composition;
}

function latestRunFailed(history: readonly SessionEvent[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === "run.failed" || event.type === "run.interrupted") return true;
    if (event.type === "run.completed" || event.type === "run.yielded" || event.type === "run.cancelled") {
      return false;
    }
  }
  return false;
}

async function inspectForkHistory(store: SessionStore, fork: AgentApplicationFork): Promise<readonly SessionEvent[]> {
  if (store.inspect === undefined) throw new Error("Session forking requires read-only store inspection");
  const history = await store.inspect(fork.sessionId);
  const position = history.find((event) => event.seq === fork.positionSeq);
  if (position?.type !== "run.settled") throw new Error("Selected history position has no recoverable state");
  return history.slice(0, fork.positionSeq);
}

function filterForkPluginState(state: ApplicationPluginState, pluginIds: readonly string[] = []): ApplicationPluginState {
  const allowed = new Set(["may.skills", ...pluginIds]);
  const select = (snapshot: ApplicationPluginState["application"]) => Object.fromEntries(
    Object.entries(snapshot).filter(([id]) => allowed.has(id)).map(([id, value]) => [id, structuredClone(value)]),
  );
  return { version: 1, application: select(state.application), session: select(state.session) };
}

/** Derive context capacity from provider-neutral model limits. */
export function contextBudgetFromModel(model: Model): ContextBudget | undefined {
  if (model.limits === undefined) return undefined;
  return {
    ...(model.limits.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.limits.contextWindowTokens }),
    ...(model.limits.maxOutputTokens === undefined
      ? {}
      : { outputReserveTokens: model.limits.maxOutputTokens }),
  };
}

function assertSessionInputOptions(options: { readonly stepInputSource?: unknown }): void {
  if (options.stepInputSource !== undefined) throw new TypeError("Session manages step input through steer(); custom stepInputSource is unsupported");
}

/** Add a default automatic-compaction threshold without overriding callers. */
export function withDefaultCompactionThreshold(
  budget: ContextBudget | undefined,
  compactTriggerRatio = 0.9,
): ContextBudget | undefined {
  if (budget?.contextWindowTokens === undefined) return budget;
  if (budget.compactTriggerRatio !== undefined) return budget;
  if (!Number.isFinite(compactTriggerRatio) || compactTriggerRatio <= 0 || compactTriggerRatio >= 1) {
    throw new RangeError("compactTriggerRatio must be greater than 0 and less than 1");
  }
  return { ...budget, compactTriggerRatio };
}
