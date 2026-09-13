import type { Context, ContextSnapshot } from "./context.js";
import { resolveRunBudget, RunBudgetMeter, RunBudgetExceededError, type RunBudget } from "./budget.js";
import {
  ConcurrentRunError,
  FatalToolExecutionError,
  MaxStepsExceededError,
  ModelProtocolError,
  RunCancelledError,
  RunCheckpointError,
  ToolNotFoundError,
  ToolSchedulerError,
} from "./errors.js";
import {
  AsyncEventQueue,
  isStreamingMayEvent,
  serializeError,
  type MayEvent,
  type MayEventPayload,
  type RunResult,
  type SerializedError,
} from "./events.js";
import type { Model, ModelRequest } from "./model.js";
import {
  directToolExecutor,
  sequentialToolScheduler,
  type Tool,
  type ToolExecutor,
  type ToolProgressUpdate,
  type ToolScheduler,
} from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  addTraceEvent,
  endTraceSpan,
  startTraceSpan,
  traceError,
  type TraceAttributes,
  type TraceContext,
  type TraceSpan,
  type Tracer,
} from "./tracing.js";
import {
  textContent,
  toolCancellationMessage,
  userMessage,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolMessage,
  type Usage,
  type UserMessage,
} from "./types.js";

export interface MayOptions {
  model: Model;
  tools?: Iterable<Tool>;
  /** Additional trusted host tools, captured exactly once at each Run/continue start. */
  toolSource?: () => Iterable<Tool>;
  /** Host-only routing labels, captured once before each Run/continue. */
  toolScope?: () => Readonly<Record<string, string>>;
  context: Context;
  maxSteps?: number;
  runBudget?: RunBudget;
  toolExecutor?: ToolExecutor;
  toolScheduler?: ToolScheduler;
  /** Maximum cancellation drain time; unresponsive tools require host reconciliation. */
  toolSettleTimeoutMs?: number;
  /** Defaults to reject because a May instance owns one mutable Context. */
  concurrentRuns?: "reject" | "allow";
  /** Streaming-event buffer target; lifecycle events are retained. */
  maxBufferedEvents?: number;
  /** Optional fail-open tracing implementation. */
  tracer?: Tracer;
  /** Content-free attributes attached to every Run span. */
  traceAttributes?: TraceAttributes;
}

export interface RunOptions {
  /** Host-only control, checked after a complete model/tool step. Never interrupts tools. */
  shouldYield?: () => boolean;
  runBudget?: RunBudget;
  input: string | UserMessage;
  /** Awaited durability barrier. Failure stops execution; never retry it blindly. */
  checkpoint?: RunCheckpoint;
  signal?: AbortSignal;
  /** Optional parent span for explicit cross-component propagation. */
  traceContext?: TraceContext;
  /** Content-free attributes added to this Run span. */
  traceAttributes?: TraceAttributes;
}

export interface ContinueOptions {
  shouldYield?: () => boolean;
  runBudget?: RunBudget;
  checkpoint?: RunCheckpoint;
  signal?: AbortSignal;
  /** Optional parent span for explicit cross-component propagation. */
  traceContext?: TraceContext;
  /** Content-free attributes added to this Run span. */
  traceAttributes?: TraceAttributes;
}

export interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<MayEvent>;
  readonly result: Promise<RunResult>;
  readonly traceContext?: TraceContext;
  cancel(reason?: string): void;
}

export type RunCheckpointEvent = Extract<MayEventPayload, {
  type: "run.started" | "model.completed" | "tool.started" | "tool.completed" | "tool.failed" | "run.yielded";
}> & { readonly runId: string };
export type RunCheckpoint = (event: RunCheckpointEvent) => Promise<void>;

export class May {
  private readonly model: Model;
  private readonly context: Context;
  private readonly tools: ToolRegistry;
  private readonly toolSource: MayOptions["toolSource"];
  private readonly toolScope: MayOptions["toolScope"];
  private readonly runScopes = new Map<string, Readonly<Record<string, string>>>();
  private readonly maxSteps: number;
  private readonly runBudget: Readonly<RunBudget>;
  private readonly toolExecutor: ToolExecutor;
  private readonly toolScheduler: ToolScheduler;
  private readonly concurrentRuns: "reject" | "allow";
  private readonly maxBufferedEvents: number;
  private readonly tracer: Tracer | undefined;
  private readonly traceAttributes: TraceAttributes;
  private activeRuns = 0;
  private unsafeToReuse = false;
  private readonly toolSettleTimeoutMs: number;

  constructor(options: MayOptions) {
    const maxSteps = options.maxSteps ?? 16;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError("maxSteps must be a positive integer");
    }

    this.toolSettleTimeoutMs = options.toolSettleTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.toolSettleTimeoutMs) || this.toolSettleTimeoutMs < 1 || this.toolSettleTimeoutMs > 2_147_483_647) throw new RangeError("toolSettleTimeoutMs must be a valid positive timer duration");
    const tools = new ToolRegistry(options.tools);

    this.model = options.model;
    this.context = options.context;
    this.tools = tools;
    this.toolSource = options.toolSource;
    this.toolScope = options.toolScope;
    this.maxSteps = maxSteps;
    this.runBudget = resolveRunBudget(options.runBudget);
    this.toolExecutor = options.toolExecutor ?? directToolExecutor;
    this.toolScheduler = options.toolScheduler ?? sequentialToolScheduler;
    this.concurrentRuns = options.concurrentRuns ?? "reject";
    if (
      this.concurrentRuns !== "reject" &&
      this.concurrentRuns !== "allow"
    ) {
      throw new TypeError("concurrentRuns must be \"reject\" or \"allow\"");
    }
    this.maxBufferedEvents = options.maxBufferedEvents ?? 1024;
    if (!Number.isSafeInteger(this.maxBufferedEvents) || this.maxBufferedEvents < 1) {
      throw new RangeError("maxBufferedEvents must be a positive safe integer");
    }
    this.tracer = options.tracer;
    this.traceAttributes = { ...(options.traceAttributes ?? {}) };
  }

  run(options: RunOptions): RunHandle {
    const input = typeof options.input === "string"
      ? userMessage(options.input)
      : options.input;
    return this.start(
      input,
      options.signal,
      options.traceContext,
      options.traceAttributes,
      options.checkpoint,
      options.runBudget,
      options.shouldYield,
    );
  }

  /** Continue from the existing context without appending a user message. */
  continue(options: ContinueOptions = {}): RunHandle {
    return this.start(
      undefined,
      options.signal,
      options.traceContext,
      options.traceAttributes,
      options.checkpoint,
      options.runBudget,
      options.shouldYield,
    );
  }

  private start(
    input: UserMessage | undefined,
    externalSignal: AbortSignal | undefined,
    parentTraceContext: TraceContext | undefined,
    runTraceAttributes: TraceAttributes | undefined,
    checkpoint: RunCheckpoint | undefined,
    budgetOverride: RunBudget | undefined,
    shouldYield: (() => boolean) | undefined,
  ): RunHandle {
    if (this.unsafeToReuse) throw new RunCheckpointError(new Error("Tool outcomes or Context are uncertain; reconcile before creating a new runtime"));
    const budget = new RunBudgetMeter(resolveRunBudget(this.runBudget, budgetOverride));
    if (this.concurrentRuns === "reject" && this.activeRuns > 0) {
      throw new ConcurrentRunError();
    }
    // Resolve before touching Context or run bookkeeping; never mid-step.
    const tools = ToolRegistry.compose(this.tools, this.toolSource?.() ?? []).snapshot();
    const scope = Object.freeze({ ...this.toolScope?.() });
    if (Object.values(scope).some((value) => typeof value !== "string")) throw new TypeError("Tool scope values must be strings");
    this.activeRuns += 1;
    const runId = createRunId();
    this.runScopes.set(runId, scope);
    const events = new AsyncEventQueue<MayEvent>({
      maxBufferedValues: this.maxBufferedEvents,
      isDroppable: isStreamingMayEvent,
    });
    const controller = new AbortController();
    const timer = budget.limits.maxDurationMs === undefined ? undefined : setTimeout(() => {
      controller.abort(new RunBudgetExceededError("durationMs", budget.limits.maxDurationMs!, budget.snapshot().elapsedMs));
    }, budget.limits.maxDurationMs);
    let seq = 0;
    const runSpan = startTraceSpan(this.tracer, "may.run", {
      ...(parentTraceContext === undefined
        ? {}
        : { parent: parentTraceContext }),
      attributes: {
        ...this.traceAttributes,
        ...(runTraceAttributes ?? {}),
        "may.run.id": runId,
        "may.run.continuation": input === undefined,
        "may.run.max_steps": this.maxSteps,
      },
    });

    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const emit = (payload: MayEventPayload): void => {
      events.push({
        ...payload,
        runId,
        seq: ++seq,
        timestamp: Date.now(),
      });
    };

    let checkpointFailure: RunCheckpointError | undefined;
    const durableCheckpoint: RunCheckpoint | undefined = checkpoint === undefined ? undefined : async (event) => {
      if (checkpointFailure !== undefined) throw checkpointFailure;
      try { await checkpoint(event); }
      catch (error) {
        checkpointFailure ??= new RunCheckpointError(error);
        controller.abort(checkpointFailure);
        throw checkpointFailure;
      }
    };

    const result = this.execute(
      tools,
      runId,
      input,
      controller.signal,
      emit,
      runSpan?.context,
      durableCheckpoint,
      budget,
      shouldYield,
      (reason) => controller.abort(reason),
    ).then(
      (value) => {
        endTraceSpan(runSpan, {
          status: "ok",
          attributes: {
            "may.run.steps": value.steps,
            "may.run.model_calls": value.modelCalls,
            "may.run.tool_calls": value.toolCalls,
            ...usageTraceAttributes(value.usage),
          },
        });
        return value;
      },
      (error: unknown) => {
        endTraceSpan(runSpan, {
          status: controller.signal.aborted || error instanceof RunCancelledError
            ? "cancelled"
            : "error",
          error: traceError(error),
        });
        throw error;
      },
    )
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        this.activeRuns -= 1;
        this.runScopes.delete(runId);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        events.close();
      });

    // Avoid an unhandled-rejection warning when a caller only consumes events.
    void result.catch(() => undefined);

    return {
      id: runId,
      events,
      result,
      ...(runSpan === undefined ? {} : { traceContext: runSpan.context }),
      cancel: (reason?: string) => controller.abort(reason),
    };
  }

  private async execute(
    tools: ToolRegistry,
    runId: string,
    input: UserMessage | undefined,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    runTraceContext: TraceContext | undefined,
    checkpoint: RunCheckpoint | undefined,
    budget: RunBudgetMeter,
    shouldYield: (() => boolean) | undefined,
    abortPending: (reason: unknown) => void,
  ): Promise<RunResult> {
    let aggregateUsage: Usage | undefined;
    let modelCalls = 0;
    let toolCalls = 0;
    let pendingTools: {
      closed?: boolean;
      readonly step: number;
      readonly calls: readonly ToolCall[];
      readonly outcomes: Array<ToolExecutionOutcome | undefined>;
      readonly executions: Array<Promise<ToolExecutionOutcome> | undefined>;
    } | undefined;
    try {
      if (signal.aborted) emit(input === undefined ? { type: "run.started", continuation: true } : { type: "run.started" });
      throwIfAborted(signal);
      if (input !== undefined) {
        await traceOperation(
          this.tracer,
          "may.context.append",
          runTraceContext,
          {
            "may.context.phase": "input",
            "may.context.message_count": 1,
          },
          signal,
          () => this.context.append([input], { runId }),
        );
      }

      await checkpoint?.({ type: "run.started", runId, ...(input === undefined ? { continuation: true } : {}) });
      emit(input === undefined
        ? { type: "run.started", continuation: true }
        : { type: "run.started" });

      for (let step = 1; step <= this.maxSteps; step++) {
        throwIfAborted(signal);
        budget.startModel(step);
        emit({ type: "step.started", step });

        const snapshotSpan = startTraceSpan(this.tracer, "may.context.snapshot", {
          ...(runTraceContext === undefined ? {} : { parent: runTraceContext }),
          attributes: { "may.step": step },
        });
        let snapshot: ContextSnapshot;
        try {
          snapshot = await this.context.snapshot({
            runId,
            step,
            signal,
          });
          endTraceSpan(snapshotSpan, {
            status: "ok",
            attributes: {
              "may.context.message_count": snapshot.messages.length,
              "may.context.has_instructions": Boolean(snapshot.instructions),
            },
          });
        } catch (error) {
          endOperationSpan(snapshotSpan, error, signal);
          throw error;
        }
        const request = this.createModelRequest(snapshot, tools);

        emit({ type: "model.started", step });
        modelCalls += 1;
        const modelCallId = `${runId}:model:${step}`;
        const modelSpan = startTraceSpan(this.tracer, "may.model.call", {
          ...(runTraceContext === undefined ? {} : { parent: runTraceContext }),
          attributes: {
            "may.step": step,
            "may.model.call_id": modelCallId,
            "may.model.message_count": request.messages.length,
            "may.model.tool_definition_count": request.tools.length,
          },
        });
        let modelResponse: { message: AssistantMessage; usage?: Usage };
        try {
          modelResponse = await this.consumeModel(
            request,
            signal,
            runId,
            step,
            modelCallId,
            emit,
            modelSpan,
          );
          endTraceSpan(modelSpan, {
            status: "ok",
            attributes: {
              "may.model.tool_call_count":
                modelResponse.message.toolCalls?.length ?? 0,
              ...usageTraceAttributes(modelResponse.usage, "may.model"),
            },
          });
        } catch (error) {
          endOperationSpan(modelSpan, error, signal);
          throw error;
        }
        const { message, usage } = modelResponse;
        aggregateUsage = addUsage(aggregateUsage, usage);

        throwIfAborted(signal);
        await traceOperation(
          this.tracer,
          "may.context.append",
          runTraceContext,
          {
            "may.step": step,
            "may.context.phase": "assistant",
            "may.context.message_count": 1,
          },
          signal,
          () => this.context.append([message], { runId, step }),
        );
        await checkpoint?.({ type: "model.completed", runId, step, message,
          contextMessageCount: snapshot.messages.length, ...(usage === undefined ? {} : { usage }) });
        emitOptionalUsage(
          emit,
          {
            type: "model.completed",
            step,
            message,
            contextMessageCount: snapshot.messages.length,
          },
          usage,
        );

        const calls = message.toolCalls ?? [];
        if (calls.length > 0) pendingTools = { step, calls, outcomes: [], executions: [] };
        budget.recordUsage(usage);
        if (calls.length === 0) {
          emit({ type: "step.completed", step });

          const result = createRunResult(
            runId,
            step,
            modelCalls,
            toolCalls,
            message,
            aggregateUsage,
          );
          result.budget = budget.snapshot();
          if (shouldYield?.() === true) {
            result.finishReason = "yielded";
            await checkpoint?.({ type: "run.yielded", runId, result });
            emit({ type: "run.yielded", result });
            return result;
          }
          emit({ type: "run.completed", result });
          return result;
        }

        budget.reserveTools(calls.length);
        toolCalls += calls.length;
        pendingTools = { step, calls, outcomes: [], executions: [] };
        const batchSpan = startTraceSpan(this.tracer, "may.tools.batch", {
          ...(runTraceContext === undefined ? {} : { parent: runTraceContext }),
          attributes: {
            "may.step": step,
            "may.tool.call_count": calls.length,
          },
        });
        let outcomes: readonly ToolExecutionOutcome[];
        try {
          outcomes = await this.scheduleTools(
            tools,
            runId,
            step,
            calls,
            signal,
            emit,
            pendingTools,
            batchSpan?.context,
            checkpoint,
          );
          const failedCount = outcomes.filter((outcome) =>
            outcome.type === "failed"
          ).length;
          endTraceSpan(batchSpan, {
            status: failedCount === 0 ? "ok" : "error",
            attributes: {
              "may.tool.completed_count": outcomes.length - failedCount,
              "may.tool.failed_count": failedCount,
            },
          });
        } catch (error) {
          endOperationSpan(batchSpan, error, signal);
          throw error;
        }
        let fatal: FatalToolExecutionError | undefined;
        await traceOperation(
          this.tracer,
          "may.context.append",
          runTraceContext,
          {
            "may.step": step,
            "may.context.phase": "tool_results",
            "may.context.message_count": outcomes.length,
          },
          signal,
          () => this.context.append(
            outcomes.map((outcome) => outcome.message),
            { runId, step },
          ),
        );
        emitToolOutcomes(step, outcomes, emit);
        for (const outcome of outcomes) {
          if (outcome.type === "failed") fatal ??= outcome.fatal;
        }
        pendingTools = undefined;
        throwIfAborted(signal);
        if (fatal !== undefined) throw fatal;

        emit({ type: "step.completed", step });
        if (shouldYield?.() === true) {
          budget.checkTime();
          const result = createRunResult(runId, step, modelCalls, toolCalls, message, aggregateUsage);
          result.budget = budget.snapshot();
          result.finishReason = "yielded";
          await checkpoint?.({ type: "run.yielded", runId, result });
          emit({ type: "run.yielded", result });
          return result;
        }
      }

      if (budget.limits.maxSteps !== undefined && budget.limits.maxSteps <= this.maxSteps) throw new RunBudgetExceededError("steps", budget.limits.maxSteps, this.maxSteps + 1);
      throw new MaxStepsExceededError(this.maxSteps);
    } catch (error) {
      const wasAborted = signal.aborted;
      if (pendingTools !== undefined) {
        abortPending(error);
        const settled = await settleWithin(pendingTools.executions.filter((value) => value !== undefined), this.toolSettleTimeoutMs);
        pendingTools.closed = true;
        if (!settled) {
          this.unsafeToReuse = true;
          const failure = new RunCheckpointError(new Error("Tools did not settle before the cancellation deadline; external effects are unknown"));
          emit({ type: "run.failed", error: serializeError(failure) });
          throw failure;
        }
        if (!wasAborted && !(error instanceof RunCancelledError) && !(error instanceof RunBudgetExceededError) && !(error instanceof RunCheckpointError)) {
          if (pendingTools.executions.some((execution, index) => execution !== undefined && pendingTools!.outcomes[index] === undefined)) {
            this.unsafeToReuse = true;
            const failure = new RunCheckpointError(new Error("Tool execution ended without a known outcome; host reconciliation is required"));
            emit({ type: "run.failed", error: serializeError(failure) });
            throw failure;
          }
          const outcomes = pendingTools.calls.map((call, index) => pendingTools!.outcomes[index] ?? createSkippedToolOutcome(call, new FatalToolExecutionError(String(error))));
          try {
            const snapshot = await this.context.snapshot();
            const assistantIndex = snapshot.messages.map((message) => message.role).lastIndexOf("assistant");
            const existing = new Set(snapshot.messages.slice(assistantIndex + 1).filter((message) => message.role === "tool").map((message) => message.toolCallId));
            await this.context.append(outcomes.filter((outcome) => !existing.has(outcome.call.id)).map((outcome) => outcome.message), { runId, step: pendingTools.step });
            emitToolOutcomes(pendingTools.step, outcomes, emit);
          } catch (contextError) {
            this.unsafeToReuse = true;
            const failure = new RunCheckpointError(contextError);
            emit({ type: "run.failed", error: serializeError(failure) });
            throw failure;
          }
          emit({ type: "run.failed", error: serializeError(error) });
          throw error;
        }
      }
      if (signal.reason instanceof RunCheckpointError) {
        this.unsafeToReuse = true;
        // A failed parallel barrier must cancel and settle peers before releasing
        // the runtime. Never synthesize successful outcomes or cancellation facts
        // for calls whose durable state is uncertain.
        emit({ type: "run.failed", error: serializeError(signal.reason) });
        throw signal.reason;
      }
      const budgetError = signal.reason instanceof RunBudgetExceededError ? signal.reason
        : error instanceof RunBudgetExceededError ? error : undefined;
      if (signal.aborted || error instanceof RunCancelledError) {
        const cancelled = error instanceof RunCancelledError
          ? error
          : new RunCancelledError(toReason(signal.reason));
        const reason = toReason(signal.reason);

        if (pendingTools !== undefined) {
          const settledOutcomes = pendingTools.outcomes.filter(
            (outcome): outcome is ToolExecutionOutcome => outcome !== undefined,
          );
          const cancellationOutcomes = pendingTools.calls.map((call, index) =>
            pendingTools?.outcomes[index] ??
              createCancelledToolOutcome(call, cancelled)
          );
          try {
            await this.context.append(
              cancellationOutcomes.map((outcome) => outcome.message),
              { runId, step: pendingTools.step },
            );
          } catch (contextError) {
            emitToolOutcomes(pendingTools.step, cancellationOutcomes, emit);
            pendingTools = undefined;
            emit({ type: "run.failed", error: serializeError(contextError) });
            throw contextError;
          }
          emitToolOutcomes(pendingTools.step, budgetError === undefined ? settledOutcomes : cancellationOutcomes, emit);
          pendingTools = undefined;
        }

        if (budgetError !== undefined) {
          emit({ type: "run.budget.exceeded", dimension: budgetError.dimension, limit: budgetError.limit, consumed: budgetError.consumed, budget: budget.snapshot() });
          emit({ type: "run.failed", error: serializeError(budgetError) });
          throw budgetError;
        }
        emit(reason === undefined
          ? { type: "run.cancelled" }
          : { type: "run.cancelled", reason });
        throw cancelled;
      }

      if (budgetError !== undefined) emit({ type: "run.budget.exceeded", dimension: budgetError.dimension, limit: budgetError.limit, consumed: budgetError.consumed, budget: budget.snapshot() });
      emit({ type: "run.failed", error: serializeError(error) });
      throw error;
    }
  }

  private createModelRequest(snapshot: ContextSnapshot, tools: ToolRegistry): ModelRequest {
    const messages: Message[] = [];

    if (snapshot.instructions) {
      messages.push({
        role: "system",
        content: textContent(snapshot.instructions),
      });
    }

    messages.push(...snapshot.messages);

    return {
      messages,
      tools: tools.definitions(),
      ...(snapshot.metadata === undefined
        ? {}
        : { metadata: snapshot.metadata }),
    };
  }

  private async consumeModel(
    request: ModelRequest,
    signal: AbortSignal,
    runId: string,
    step: number,
    modelCallId: string,
    emit: (event: MayEventPayload) => void,
    modelSpan: TraceSpan | undefined,
  ): Promise<{ message: AssistantMessage; usage?: Usage }> {
    let completed: AssistantMessage | undefined;
    let usage: Usage | undefined;

    for await (const event of this.model.stream(request, {
      signal,
      runId,
      step,
      modelCallId,
      ...(modelSpan === undefined
        ? {}
        : { traceContext: modelSpan.context }),
    })) {
      throwIfAborted(signal);

      if (event.type === "text.delta") {
        emit({ type: "model.text.delta", step, delta: event.delta });
        continue;
      }

      if (event.type === "reasoning.delta") {
        emit({ type: "model.reasoning.delta", step, delta: event.delta });
        continue;
      }

      if (event.type === "retrying") {
        addTraceEvent(modelSpan, "may.model.retry", {
          "may.model.retry.attempt": event.attempt,
          "may.model.retry.max_attempts": event.maxAttempts,
          "may.model.retry.delay_ms": event.delayMs,
          "error.type": event.error.name,
          ...(event.error.code === undefined
            ? {}
            : { "error.code": event.error.code }),
        });
        emit({
          type: "model.retrying",
          step,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.error,
        });
        continue;
      }

      if (completed) {
        throw new ModelProtocolError(
          "Model emitted more than one response.completed event",
        );
      }

      completed = event.message;
      usage = event.usage;
    }

    if (!completed) {
      throw new ModelProtocolError(
        "Model stream ended without a response.completed event",
      );
    }

    const result: { message: AssistantMessage; usage?: Usage } = {
      message: completed,
    };
    if (usage !== undefined) result.usage = usage;
    return result;
  }

  private async scheduleTools(
    tools: ToolRegistry,
    runId: string,
    step: number,
    calls: readonly ToolCall[],
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    pending: {
      closed?: boolean;
      readonly outcomes: Array<ToolExecutionOutcome | undefined>;
      readonly executions: Array<Promise<ToolExecutionOutcome> | undefined>;
    },
    batchTraceContext: TraceContext | undefined,
    checkpoint: RunCheckpoint | undefined,
  ): Promise<readonly ToolExecutionOutcome[]> {
    const operations = calls.map((call, index) => {
      let execution: Promise<ToolExecutionOutcome> | undefined;
      return {
        call,
        tool: tools.get(call.name),
        execute: () => {
          signal.throwIfAborted();
          execution ??= this.executeTool(
            tools,
            runId,
            step,
            call,
            signal,
            emit,
            batchTraceContext,
            checkpoint,
          )
            .then(async (outcome) => {
              if (pending.closed) return outcome;
              pending.outcomes[index] = outcome;
              await checkpoint?.(outcome.type === "completed"
                ? { type: "tool.completed", runId, step, call, output: outcome.output }
                : { type: "tool.failed", runId, step, call, error: outcome.error });
              return outcome;
            });
          pending.executions[index] = execution;
          return execution;
        },
        isTerminal: (outcome: ToolExecutionOutcome) =>
          outcome.type === "failed" && outcome.fatal !== undefined,
      };
    });
    const outcomes = await abortable(this.toolScheduler.schedule(operations, { runId, step, signal }), signal);
    if (outcomes.length > calls.length) {
      throw new ToolSchedulerError(
        `Tool scheduler returned ${outcomes.length} results for ${calls.length} calls`,
      );
    }
    for (let index = 0; index < outcomes.length; index++) {
      if (outcomes[index]?.call !== calls[index]) {
        throw new ToolSchedulerError(
          "Tool scheduler must return results in call order",
        );
      }
    }
    if (outcomes.length === calls.length) return outcomes;

    const terminal = outcomes.at(-1);
    if (
      terminal?.type !== "failed" ||
      terminal.fatal === undefined
    ) {
      throw new ToolSchedulerError(
        `Tool scheduler returned ${outcomes.length} results for ${calls.length} calls`,
      );
    }

    const fatal = terminal.fatal;
    return [
      ...outcomes,
      ...calls.slice(outcomes.length).map((call) =>
        createSkippedToolOutcome(call, fatal)
      ),
    ];
  }

  private async executeTool(
    tools: ToolRegistry,
    runId: string,
    step: number,
    call: ToolCall,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    parentTraceContext: TraceContext | undefined,
    checkpoint: RunCheckpoint | undefined,
  ): Promise<ToolExecutionOutcome> {
    await checkpoint?.({ type: "tool.started", runId, step, call });
    throwIfAborted(signal);
    emit({ type: "tool.started", step, call });
    let active = true;
    const toolSpan = startTraceSpan(this.tracer, "may.tool.call", {
      ...(parentTraceContext === undefined
        ? {}
        : { parent: parentTraceContext }),
      attributes: {
        "may.step": step,
        "may.tool.name": call.name,
        "may.tool.call_id": call.id,
      },
    });

    try {
      const tool = tools.get(call.name);
      if (!tool) throw new ToolNotFoundError(call.name);

      const input = tool.parse ? tool.parse(call.input) : call.input;
      const output = await this.toolExecutor.execute({
        tool,
        input,
        context: {
          scope: this.runScopes.get(runId)!,
          runId,
          step,
          toolCallId: call.id,
          idempotencyKey: `${runId}:${step}:${call.id}`,
          signal,
          ...(toolSpan === undefined
            ? {}
            : { traceContext: toolSpan.context }),
          report: (update) => {
            if (!active || signal.aborted) return;
            emitToolProgress(step, call, update, emit);
          },
        },
      });

      const content = tool.resultContent?.(output) ?? [{ type: "json" as const, value: output }];
      endTraceSpan(toolSpan, { status: "ok" });
      return {
        type: "completed",
        call,
        output,
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        },
      };
    } catch (error) {
      if (signal.aborted || error instanceof RunCancelledError) {
        endOperationSpan(toolSpan, error, signal);
        throw error;
      }

      const serialized = serializeError(error);
      endTraceSpan(toolSpan, {
        status: "error",
        error: traceError(error),
      });
      const outcome: FailedToolExecution = {
        type: "failed",
        call,
        error: serialized,
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: [{ type: "json", value: serialized }],
        },
      };
      if (error instanceof FatalToolExecutionError) outcome.fatal = error;
      return outcome;
    } finally {
      active = false;
    }
  }

  /** Append trusted host context while idle, without invoking a model. */
  async appendMessages(messages: Message[]): Promise<void> {
    if (this.unsafeToReuse) throw new RunCheckpointError(new Error("Runtime requires reconciliation"));
    if (this.activeRuns > 0) throw new ConcurrentRunError();
    await this.context.append(messages);
  }
}

interface CompletedToolExecution {
  readonly type: "completed";
  readonly call: ToolCall;
  readonly output: unknown;
  readonly message: ToolMessage;
}

interface FailedToolExecution {
  readonly type: "failed";
  readonly call: ToolCall;
  readonly error: SerializedError;
  readonly message: ToolMessage;
  fatal?: FatalToolExecutionError;
}

type ToolExecutionOutcome = CompletedToolExecution | FailedToolExecution;

function createCancelledToolOutcome(
  call: ToolCall,
  error: RunCancelledError,
): FailedToolExecution {
  return {
    type: "failed",
    call,
    error: serializeError(error),
    message: toolCancellationMessage(call, error.message),
  };
}

function createSkippedToolOutcome(
  call: ToolCall,
  fatal: FatalToolExecutionError,
): FailedToolExecution {
  const error: SerializedError = {
    name: "ToolSkippedError",
    message: `Tool \"${call.name}\" was not executed because a previous tool failed fatally: ${fatal.message}`,
    code: "TOOL_SKIPPED",
  };
  return {
    type: "failed",
    call,
    error,
    message: {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      isError: true,
      content: [{ type: "json", value: error }],
    },
  };
}

function emitToolOutcomes(
  step: number,
  outcomes: readonly ToolExecutionOutcome[],
  emit: (event: MayEventPayload) => void,
): void {
  for (const outcome of outcomes) {
    if (outcome.type === "completed") {
      emit({
        type: "tool.completed",
        step,
        call: outcome.call,
        output: outcome.output,
      });
    } else {
      emit({
        type: "tool.failed",
        step,
        call: outcome.call,
        error: outcome.error,
      });
    }
  }
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunCancelledError(toReason(signal.reason));
  }
}

function toReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return undefined;
}

function createRunResult(
  runId: string,
  steps: number,
  modelCalls: number,
  toolCalls: number,
  message: AssistantMessage,
  usage: Usage | undefined,
): RunResult {
  const result: RunResult = {
    runId,
    steps,
    modelCalls,
    toolCalls,
    message,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

function addUsage(
  aggregate: Usage | undefined,
  usage: Usage | undefined,
): Usage | undefined {
  if (usage === undefined) return aggregate;
  const result: Usage = { ...(aggregate ?? {}) };
  addTokenField(result, "inputTokens", usage.inputTokens);
  addTokenField(result, "outputTokens", usage.outputTokens);
  addTokenField(result, "totalTokens", usage.totalTokens);
  return result;
}

function addTokenField(
  target: Usage,
  field: keyof Usage,
  value: number | undefined,
): void {
  if (value !== undefined) target[field] = (target[field] ?? 0) + value;
}

async function traceOperation<T>(
  tracer: Tracer | undefined,
  name: string,
  parent: TraceContext | undefined,
  attributes: TraceAttributes,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const span = startTraceSpan(tracer, name, {
    ...(parent === undefined ? {} : { parent }),
    attributes,
  });
  try {
    const value = await operation();
    endTraceSpan(span, { status: "ok" });
    return value;
  } catch (error) {
    endOperationSpan(span, error, signal);
    throw error;
  }
}

function endOperationSpan(
  span: TraceSpan | undefined,
  error: unknown,
  signal: AbortSignal,
): void {
  endTraceSpan(span, {
    status: signal.aborted || error instanceof RunCancelledError
      ? "cancelled"
      : "error",
    error: traceError(error),
  });
}

function usageTraceAttributes(
  usage: Usage | undefined,
  prefix = "may.run",
): TraceAttributes {
  if (usage === undefined) return {};
  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { [`${prefix}.input_tokens`]: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { [`${prefix}.output_tokens`]: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { [`${prefix}.total_tokens`]: usage.totalTokens }),
  };
}

function emitToolProgress(
  step: number,
  call: ToolCall,
  update: ToolProgressUpdate,
  emit: (event: MayEventPayload) => void,
): void {
  if (update.type === "output.delta") {
    if (typeof update.delta !== "string") {
      throw new TypeError("Tool output delta must be a string");
    }
    if (update.delta === "") return;
    emit(update.channel === undefined
      ? { type: "tool.output.delta", step, call, delta: update.delta }
      : {
          type: "tool.output.delta",
          step,
          call,
          delta: update.delta,
          channel: update.channel,
        });
    return;
  }

  if (update.type !== "progress" || typeof update.message !== "string") {
    throw new TypeError("Tool progress update is invalid");
  }
  emit(update.data === undefined
    ? { type: "tool.progress", step, call, message: update.message }
    : {
        type: "tool.progress",
        step,
        call,
        message: update.message,
        data: update.data,
      });
}

function emitOptionalUsage(
  emit: (event: MayEventPayload) => void,
  event: Extract<MayEventPayload, { type: "model.completed" }>,
  usage: Usage | undefined,
): void {
  emit(usage === undefined ? event : { ...event, usage });
}

async function settleWithin(pending: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.allSettled(pending).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new RunCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
