import {
  type ContextBudget,
  type ContextCompactionFailure,
  type ContextCompactionOptions,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextController,
  type ContextFactory,
  type ContextInspection,
  InMemoryContextFactory,
  ModelContextCompactionStrategy,
} from "@may/context";
import {
  AsyncEventQueue,
  endTraceSpan,
  isStreamingMayEvent,
  May,
  serializeError,
  startTraceSpan,
  ToolRegistry,
  traceError,
  type Message,
  type Model,
  type RunHandle,
  type RunOptions,
  type RunBudget,
  type Tool,
  type ToolExecutor,
  type ToolScheduler,
  type TraceAttributes,
  type Tracer,
} from "@may/core";
import {
  PermissionToolExecutor,
  type ApprovalDecision,
  type PermissionCheck,
  type PermissionPolicy,
} from "@may/permissions";
import {
  Session,
  type SessionEvent,
  type SessionHistoryPage,
  type SessionHistoryQuery,
  type SessionRuntimeInfo,
  type SessionStore,
  type SessionToolPresentation,
} from "@may/session";
import {
  createSessionHistoryTool,
  type SessionHistoryToolOptions,
} from "@may/session-tools";

import type { AgentController } from "./controller.js";
import type { AgentApplicationEvent, AgentRun } from "./events.js";

export interface AgentToolPresentation {
  readonly kind: string;
  readonly version: number;
  readonly data: unknown;
}

export interface AgentApplicationOptions {
  readonly model: Model;
  readonly store: SessionStore;
  readonly permissionPolicy: PermissionPolicy;
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
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  /** Default strategy used by explicit compaction and by the context itself. */
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Include the model-native compactor in the automatic chain, when present. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  /** Add the bounded session_history tool with these optional limits. */
  readonly sessionHistory?: false | Omit<SessionHistoryToolOptions, "source">;
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
export class AgentApplication implements AgentController {
  readonly events: AsyncIterable<AgentApplicationEvent>;
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;

  private readonly session: Session;
  private readonly permissions: PermissionToolExecutor;
  private readonly contextController: ContextController | undefined;
  private readonly compactionStrategy: ContextCompactionStrategy | undefined;
  private readonly closeReason: string;
  private readonly tracer: Tracer | undefined;
  private readonly eventQueue = new AsyncEventQueue<AgentApplicationEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) =>
      value.type === "run.event" && isStreamingMayEvent(value.event),
  });
  private readonly permissionRelay: Promise<void>;
  private readonly runRelays = new Set<Promise<void>>();
  private currentRun: AgentRun | undefined;
  private activeCompaction: ActiveCompaction | undefined;
  private starting = false;
  private closed = false;

  private constructor(
    session: Session,
    permissions: PermissionToolExecutor,
    contextController: ContextController | undefined,
    compactionStrategy: ContextCompactionStrategy | undefined,
    closeReason: string,
    tracer: Tracer | undefined,
  ) {
    this.session = session;
    this.sessionId = session.id;
    this.metadata = session.metadata;
    this.permissions = permissions;
    this.contextController = contextController;
    this.compactionStrategy = compactionStrategy;
    this.closeReason = closeReason;
    this.tracer = tracer;
    this.events = this.eventQueue;
    this.permissionRelay = this.relayPermissionEvents();
  }

  static async open(options: AgentApplicationOptions): Promise<AgentApplication> {
    let application: AgentApplication | undefined;
    let historySource: Session | undefined;
    const configuredTools = new ToolRegistry(options.tools);
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
    }

    const permissions = new PermissionToolExecutor({
      policy: async (check) => {
        const presentation = await options.createToolPresentation?.(check);
        if (presentation !== undefined) {
          if (application === undefined) {
            throw new Error("Tool presentation requested before session creation");
          }
          await application.recordToolPresentation(check, presentation);
        }
        return options.permissionPolicy(check);
      },
      ...(options.toolExecutor === undefined
        ? {}
        : { executor: options.toolExecutor }),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });

    const contextFactory = options.contextFactory ?? new InMemoryContextFactory();
    let contextController: ContextController | undefined;
    const nativeCompactionStrategy =
      options.providerNativeAutoCompaction === true &&
        options.model.contextCompactor !== undefined
        ? new ModelContextCompactionStrategy(options.model.contextCompactor)
        : undefined;
    const autoCompactionStrategies = options.autoCompactionStrategies ??
      (nativeCompactionStrategy === undefined ? [] : [nativeCompactionStrategy]);
    const createRuntime = async (
      messages: Message[] = [],
      runtimeInfo: SessionRuntimeInfo = {},
    ) => {
      const contextMetadata = options.contextMetadata ?? options.metadata;
      const managedContext = await contextFactory.create({
        ...(options.instructions === undefined
          ? {}
          : { instructions: options.instructions }),
        messages,
        ...(contextMetadata === undefined
          ? {}
          : { metadata: contextMetadata }),
        ...(options.contextBudget === undefined
          ? {}
          : { budget: options.contextBudget }),
        ...(runtimeInfo.latestModelMeasurement === undefined
          ? {}
          : { measurement: runtimeInfo.latestModelMeasurement }),
        ...(options.compactionStrategy === undefined
          ? {}
          : { compactionStrategy: options.compactionStrategy }),
        autoCompactionStrategies,
      });
      contextController = managedContext.controller;
      return new May({
        model: options.model,
        tools: configuredTools,
        toolScope: () => ({ ...options.toolScope, sessionId: historySource!.id }),
        ...(options.toolSource === undefined ? {} : { toolSource: options.toolSource }),
        context: managedContext.context,
        toolExecutor: permissions,
        ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
        ...(options.traceAttributes === undefined
          ? {}
          : { traceAttributes: options.traceAttributes }),
        ...(options.toolScheduler === undefined
          ? {}
          : { toolScheduler: options.toolScheduler }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
      });
    };

    const openSpan = startTraceSpan(options.tracer, "may.application.open", {
      attributes: {
        ...(options.traceAttributes ?? {}),
        "may.application.resume": options.resume === true,
        ...(options.sessionId === undefined
          ? {}
          : { "may.session.id": options.sessionId }),
      },
    });
    try {
      const session = options.resume === true
        ? await resumeSession(options, createRuntime)
        : await Session.create({
            runtime: await createRuntime(),
            store: options.store,
            ...(options.metadata === undefined
              ? {}
              : { metadata: { ...options.metadata } }),
            ...(options.sessionId === undefined ? {} : { id: options.sessionId }),
          });
      historySource = session;
      await options.validateSession?.(session.metadata);
      permissions.setEventSink((event) => session.recordPermissionEvent(event));
      application = new AgentApplication(
        session,
        permissions,
        contextController,
        options.compactionStrategy,
        options.closeReason ?? "Agent application is closing",
        options.tracer,
      );
      contextController?.setAutoCompactionSink?.((result, compactionOptions) =>
        application!.recordAutomaticCompaction(result, compactionOptions)
      );
      contextController?.setAutoCompactionFailureSink?.((failure) =>
        application!.recordAutomaticCompactionFailure(failure)
      );
      endTraceSpan(openSpan, {
        status: "ok",
        attributes: { "may.session.id": session.id },
      });
      return application;
    } catch (error) {
      endTraceSpan(openSpan, { status: "error", error: traceError(error) });
      await permissions.close();
      throw error;
    }
  }

  get isRunning(): boolean {
    return this.starting ||
      this.currentRun !== undefined ||
      this.activeCompaction !== undefined;
  }

  submit(options: RunOptions): Promise<AgentRun> {
    return this.startRun(() => this.session.submit(options));
  }

  listRecoveries() { return this.session.listRecoveries(); }

  resolveRecovery(id: string, finding: string): Promise<void> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot resolve recovery while an operation is active");
    return this.session.resolveRecovery(id, finding);
  }

  /** Retry the latest failed run without adding another user message. */
  retry(): Promise<AgentRun> {
    return this.startRun(async () => {
      if (!latestRunFailed(await this.session.history())) {
        throw new Error("The latest run did not fail; there is nothing to retry");
      }
      return this.session.continue();
    });
  }

  private async startRun(start: () => Promise<RunHandle>): Promise<AgentRun> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("An agent operation is already active");

    this.starting = true;
    try {
      const run = await start();
      const relay = this.relayRunEvents(run.events);
      this.runRelays.add(relay);
      void relay.finally(() => this.runRelays.delete(relay));

      const result = relay.then(() => run.result);
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
    } finally {
      this.starting = false;
    }
  }

  cancel(reason = "Cancelled by user"): boolean {
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
  ): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.resolve(requestId, decision);
  }

  history(): Promise<readonly SessionEvent[]> {
    return this.session.history();
  }

  queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
    return this.session.queryHistory(query);
  }

  async inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.contextController?.inspect();
  }

  async compactContext(
    strategy = this.compactionStrategy,
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
    const result = await this.contextController!.compact!(strategy, { signal });
    if (result.changed) await this.persistCompaction(result);
    return result;
  }

  private async recordAutomaticCompaction(
    result: ContextCompactionResult,
    options: ContextCompactionOptions,
  ): Promise<void> {
    await this.persistCompaction(result, options);
    this.eventQueue.push({
      type: "context.compacted",
      strategy: result.strategy,
      before: result.before,
      after: result.after,
    });
  }

  private recordAutomaticCompactionFailure(
    failure: ContextCompactionFailure,
  ): void {
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const active = this.currentRun;
    active?.cancel(this.closeReason);
    await active?.result.catch(() => undefined);
    const compaction = this.activeCompaction;
    compaction?.controller.abort(this.closeReason);
    await compaction?.result.catch(() => undefined);
    await this.permissions.close(this.closeReason);
    await Promise.all([...this.runRelays]);
    await this.permissionRelay;
    this.contextController?.setAutoCompactionSink?.(undefined);
    this.contextController?.setAutoCompactionFailureSink?.(undefined);
    this.eventQueue.close();
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
  ) => Promise<May>,
): Promise<Session> {
  if (options.sessionId === undefined) {
    throw new Error("sessionId is required when resuming a session");
  }
  return Session.resume({
    id: options.sessionId,
    store: options.store,
    createRuntime: (messages, info) => createRuntime(messages, info),
  });
}

function latestRunFailed(history: readonly SessionEvent[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === "run.failed") return true;
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      return false;
    }
  }
  return false;
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
