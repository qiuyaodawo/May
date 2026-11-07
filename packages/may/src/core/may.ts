import type { Context, ContextSnapshot } from "./context.js";
import { createModelRequest, consumeModel } from "./model-step.js";
import { resolveRunBudget, RunBudgetMeter, RunBudgetExceededError, type RunBudget } from "./budget.js";
import {
  ConcurrentRunError,
  FatalToolExecutionError,
  HookExecutionError,
  MaxStepsExceededError,
  ModelProtocolError,
  ModelResponseValidationError,
  RunCancelledError,
  RunCheckpointError,
  ToolNotFoundError,
  ToolHookDeniedError,
  ToolSchedulerError,
} from "./errors.js";
import {
  AsyncEventQueue,
  isStreamingMayEvent,
  serializeError,
  type MayEvent,
  type MayEventPayload,
  type RunResult,
} from "./events.js";
import type { Model, ModelRequest, ModelResponseFormat } from "./model.js";
import { randomUUID } from "node:crypto";
import type { ModelRequestSink } from "./request-recording.js";
import { runtimeHooks, RUNTIME_HOOKS, type HookContext, type HookDefinition, type HookDispatcher } from "./hooks.js";
import { DEFAULT_RUNTIME_DESCRIPTOR, type AgentRuntime } from "./runtime.js";
import { jsonEqual } from "./json-equal.js";
import { omitUndefined } from "./omit-undefined.js";
import {
  directToolExecutor,
  freezeToolInput,
  sequentialToolScheduler,
  type Tool,
  type ToolExecutor,
  type ToolProgressUpdate,
  type ToolScheduler,
} from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  endTraceSpan,
  setTraceAttributes,
  startTraceSpan,
  traceError,
  type TraceAttributes,
  type TraceContext,
  type TraceSpan,
  type Tracer,
} from "./tracing.js";
import { aggregateUsage as mergeUsage, type UsageCost } from "./pricing.js";
import {
  traceOperation,
  endOperationSpan,
  modelConfigurationTraceAttributes,
  usageTraceAttributes,
  costTraceAttributes,
} from "./run-tracing.js";
import {
  createCancelledToolOutcome,
  createSkippedToolOutcome,
  emitToolOutcomes,
  emitToolProgress,
  type FailedToolExecution,
  type ToolExecutionOutcome,
} from "./tool-outcomes.js";
import {
  userMessage,
  type AssistantMessage,
  type ContentPart,
  type Message,
  type ToolCall,
  type Usage,
  type UserMessage,
} from "./types.js";

/** @experimental */
export interface MayOptions {
  model: Model;
  responseFormat?: ModelResponseFormat;
  hooks?: HookDispatcher;
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

/** @experimental */
export interface RunOptions {
  readonly recordRequest?: ModelRequestSink;
  /** Host-only control, checked after a complete model/tool step. Never interrupts tools. */
  shouldYield?: () => boolean;
  /** 完整 Step 结束后接收输入；返回前由 host 保存输入记录。 */
  stepInputSource?: StepInputSource;
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

/** @experimental */
export interface ContinueOptions {
  readonly recordRequest?: ModelRequestSink;
  shouldYield?: () => boolean;
  stepInputSource?: StepInputSource;
  runBudget?: RunBudget;
  checkpoint?: RunCheckpoint;
  signal?: AbortSignal;
  /** Optional parent span for explicit cross-component propagation. */
  traceContext?: TraceContext;
  /** Content-free attributes added to this Run span. */
  traceAttributes?: TraceAttributes;
}

/** @experimental */
export interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<MayEvent>;
  readonly result: Promise<RunResult>;
  readonly traceContext?: TraceContext;
  cancel(reason?: string): void;
}

/** @experimental */
export type RunCheckpointEvent = Extract<
  MayEventPayload,
  {
    type:
      | "run.started"
      | "model.completed"
      | "tool.started"
      | "tool.completed"
      | "tool.failed"
      | "run.yielded"
      | "input.generated";
  }
> & { readonly runId: string };
/** @experimental */
export type RunCheckpoint = (event: RunCheckpointEvent) => Promise<void>;

/** @experimental */
export type StepInputSource = (boundary: {
  readonly runId: string;
  readonly step: number;
  readonly signal: AbortSignal;
}) => Promise<readonly UserMessage[]>;

interface RunExecution {
  readonly tools: ToolRegistry;
  readonly runId: string;
  readonly input: UserMessage | undefined;
  readonly signal: AbortSignal;
  readonly emit: (event: MayEventPayload) => void;
  readonly runTraceContext: TraceContext | undefined;
  readonly checkpoint: RunCheckpoint | undefined;
  readonly budget: RunBudgetMeter;
  readonly shouldYield: (() => boolean) | undefined;
  readonly stepInputSource: StepInputSource | undefined;
  readonly abortPending: (reason: unknown) => void;
  readonly recordRequest: ModelRequestSink | undefined;
}

/** @experimental */
export class May implements AgentRuntime {
  get supportsRequestRecording(): boolean {
    return this.model.supportsRequestRecording === true;
  }
  readonly descriptor = DEFAULT_RUNTIME_DESCRIPTOR;
  readonly supportedHooks = RUNTIME_HOOKS;
  private readonly hooks: HookDispatcher | undefined;
  private readonly model: Model;
  private readonly responseFormat: ModelResponseFormat | undefined;
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
    if (
      !Number.isSafeInteger(this.toolSettleTimeoutMs) ||
      this.toolSettleTimeoutMs < 1 ||
      this.toolSettleTimeoutMs > 2_147_483_647
    )
      throw new RangeError("toolSettleTimeoutMs must be a valid positive timer duration");
    const tools = new ToolRegistry(options.tools);

    this.model = options.model;
    this.responseFormat = options.responseFormat === undefined ? undefined : structuredClone(options.responseFormat);
    this.hooks = options.hooks;
    this.context = options.context;
    this.tools = tools;
    this.toolSource = options.toolSource;
    this.toolScope = options.toolScope;
    this.maxSteps = maxSteps;
    this.runBudget = resolveRunBudget(options.runBudget);
    this.toolExecutor = options.toolExecutor ?? directToolExecutor;
    this.toolScheduler = options.toolScheduler ?? sequentialToolScheduler;
    this.concurrentRuns = options.concurrentRuns ?? "reject";
    this.maxBufferedEvents = options.maxBufferedEvents ?? 1024;
    if (!Number.isSafeInteger(this.maxBufferedEvents) || this.maxBufferedEvents < 1) {
      throw new RangeError("maxBufferedEvents must be a positive safe integer");
    }
    this.tracer = options.tracer;
    this.traceAttributes = { ...(options.traceAttributes ?? {}) };
  }

  run(options: RunOptions): RunHandle {
    return this.start(typeof options.input === "string" ? userMessage(options.input) : options.input, options);
  }

  /** Continue from the existing context without appending a user message. */
  continue(options: ContinueOptions = {}): RunHandle {
    return this.start(undefined, options);
  }

  private start(input: UserMessage | undefined, options: ContinueOptions): RunHandle {
    const {
      signal: externalSignal,
      traceContext: parentTraceContext,
      traceAttributes: runTraceAttributes,
      checkpoint,
      runBudget: budgetOverride,
      shouldYield,
      stepInputSource,
      recordRequest,
    } = options;
    if (recordRequest !== undefined && this.model.supportsRequestRecording !== true)
      throw new Error("Model does not support complete request recording");
    if (this.unsafeToReuse)
      throw new RunCheckpointError(
        new Error("Tool outcomes or Context are uncertain; reconcile before creating a new runtime"),
      );
    const budget = new RunBudgetMeter(resolveRunBudget(this.runBudget, budgetOverride));
    if (this.concurrentRuns === "reject" && this.activeRuns > 0) {
      throw new ConcurrentRunError();
    }
    // Resolve before touching Context or run bookkeeping; never mid-step.
    const tools = ToolRegistry.compose(this.tools, this.toolSource?.() ?? []).snapshot();
    const scope = Object.freeze({ ...this.toolScope?.() });
    if (Object.values(scope).some((value) => typeof value !== "string"))
      throw new TypeError("Tool scope values must be strings");
    this.activeRuns += 1;
    const runId = createRunId();
    this.runScopes.set(runId, scope);
    const events = new AsyncEventQueue<MayEvent>({
      maxBufferedValues: this.maxBufferedEvents,
      isDroppable: isStreamingMayEvent,
    });
    const controller = new AbortController();
    const timer =
      budget.limits.maxDurationMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(
              new RunBudgetExceededError("durationMs", budget.limits.maxDurationMs!, budget.snapshot().elapsedMs),
            );
          }, budget.limits.maxDurationMs);
    let seq = 0;
    const runSpan = startTraceSpan(
      this.tracer,
      "may.run",
      omitUndefined({
        parent: parentTraceContext,
        attributes: {
          ...this.traceAttributes,
          ...(runTraceAttributes ?? {}),
          "may.run.id": runId,
          "may.run.continuation": input === undefined,
          "may.run.max_steps": this.maxSteps,
        },
      }),
    );

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
    const durableCheckpoint: RunCheckpoint | undefined =
      checkpoint === undefined
        ? undefined
        : async (event) => {
            if (checkpointFailure !== undefined) throw checkpointFailure;
            try {
              await checkpoint(event);
            } catch (error) {
              checkpointFailure ??= new RunCheckpointError(error);
              controller.abort(checkpointFailure);
              throw checkpointFailure;
            }
          };

    const result = this.execute({
      tools,
      runId,
      input,
      signal: controller.signal,
      emit,
      runTraceContext: runSpan?.context,
      checkpoint: durableCheckpoint,
      budget,
      shouldYield,
      stepInputSource,
      abortPending: (reason) => controller.abort(reason),
      recordRequest,
    })
      .then(
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
        async (error: unknown) => {
          const snapshot = budget.snapshot();
          endTraceSpan(runSpan, {
            status: controller.signal.aborted || error instanceof RunCancelledError ? "cancelled" : "error",
            error: traceError(error),
            attributes: omitUndefined({
              "may.run.model_calls": snapshot.modelCalls,
              "may.run.tool_calls": snapshot.toolCalls,
              "may.run.steps": snapshot.steps,
              "may.run.total_tokens": snapshot.totalTokens,
              "may.run.usage_complete": snapshot.usageComplete,
              "may.run.cost_usd": snapshot.costUsd,
              "may.run.cost_complete": snapshot.costComplete === true,
              "may.run.cost_kind": snapshot.costKind,
            }),
          });
          try {
            await this.observe(
              runtimeHooks.runFailed,
              { error: serializeError(error) },
              { runId, signal: controller.signal },
            );
          } catch (observerError) {
            throw new AggregateError([error, observerError], "Run and failure Hook both failed", { cause: error });
          }
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

    return omitUndefined({
      id: runId,
      events,
      result,
      traceContext: runSpan?.context,
      cancel: (reason?: string) => controller.abort(reason),
    });
  }

  private async execute(run: RunExecution): Promise<RunResult> {
    const {
      tools,
      runId,
      input,
      signal,
      emit,
      runTraceContext,
      checkpoint,
      budget,
      shouldYield,
      stepInputSource,
      abortPending,
      recordRequest,
    } = run;
    const yieldRun = async (step: number, result: RunResult): Promise<RunResult> => {
      result.finishReason = "yielded";
      await checkpoint?.({ type: "run.yielded", runId, result });
      await this.observe(runtimeHooks.runEnded, result, { runId, step, signal });
      emit({ type: "run.yielded", result });
      return result;
    };
    let aggregateUsage: Usage | undefined;
    let modelCalls = 0;
    let toolCalls = 0;
    let pendingTools:
      | {
          closed?: boolean;
          readonly step: number;
          readonly calls: readonly ToolCall[];
          readonly outcomes: Array<ToolExecutionOutcome | undefined>;
          readonly executions: Array<Promise<ToolExecutionOutcome> | undefined>;
        }
      | undefined;
    try {
      if (signal.aborted)
        emit(input === undefined ? { type: "run.started", continuation: true } : { type: "run.started" });
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

      await this.observe(runtimeHooks.runBefore, { continuation: input === undefined }, { runId, signal });
      throwIfAborted(signal);
      await checkpoint?.({ type: "run.started", runId, ...(input === undefined ? { continuation: true } : {}) });
      emit(input === undefined ? { type: "run.started", continuation: true } : { type: "run.started" });
      await this.observe(runtimeHooks.runStarted, { continuation: input === undefined }, { runId, signal });

      for (let step = 1; step <= this.maxSteps; step++) {
        throwIfAborted(signal);
        budget.startModel(step);
        await this.observe(runtimeHooks.stepBefore, { step }, { runId, step, signal });
        emit({ type: "step.started", step });

        const snapshotSpan = startTraceSpan(
          this.tracer,
          "may.context.snapshot",
          omitUndefined({
            parent: runTraceContext,
            attributes: { "may.step": step },
          }),
        );
        let snapshot: ContextSnapshot;
        let contextMessageCount: number;
        try {
          await this.observe(runtimeHooks.contextBefore, { step }, { runId, step, signal });
          snapshot = await this.context.snapshot({
            runId,
            step,
            signal,
          });
          contextMessageCount = snapshot.messages.length;
          snapshot = await this.transform(runtimeHooks.contextAfter, snapshot, { runId, step, signal });
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
        const request = await this.transform(runtimeHooks.modelBefore, this.createModelRequest(snapshot, tools), {
          runId,
          step,
          signal,
        });
        for (const definition of request.tools) {
          if (!tools.get(definition.name))
            throw new ModelProtocolError(`Hook requested an unavailable tool: ${definition.name}`);
        }
        throwIfAborted(signal);

        emit({ type: "model.started", step });
        modelCalls += 1;
        const modelCallId = `${runId}:model:${step}`;
        const modelSpan = startTraceSpan(
          this.tracer,
          "may.model.call",
          omitUndefined({
            parent: runTraceContext,
            attributes: {
              "may.step": step,
              "may.model.call_id": modelCallId,
              ...modelConfigurationTraceAttributes(this.model),
              "may.model.message_count": request.messages.length,
              "may.model.tool_definition_count": request.tools.length,
            },
          }),
        );
        let modelResponse: { message: AssistantMessage; usage?: Usage; cost?: UsageCost };
        let responseUsage: Usage | undefined;
        let accounted = false;
        try {
          modelResponse = await this.consumeModel(
            request,
            signal,
            runId,
            step,
            modelCallId,
            emit,
            modelSpan,
            recordRequest,
          );
          responseUsage = modelResponse.usage;
          aggregateUsage = mergeUsage(aggregateUsage, responseUsage);
          accounted = true;
          budget.recordUsage(responseUsage, modelResponse.cost);
          if (!budget.snapshot().usageComplete && aggregateUsage !== undefined) {
            aggregateUsage = {
              ...aggregateUsage,
              completeness: { status: "partial", reason: "one-or-more-responses-have-incomplete-usage" },
            };
          }
          const modelCost = budget.snapshot().latestCost;
          endTraceSpan(modelSpan, {
            status: "ok",
            attributes: {
              "may.model.tool_call_count": modelResponse.message.toolCalls?.length ?? 0,
              ...usageTraceAttributes(modelResponse.usage, "may.model"),
              ...(modelCost === undefined ? {} : costTraceAttributes(modelCost)),
              ...modelConfigurationTraceAttributes(this.model),
            },
          });
        } catch (error) {
          let failure = error;
          if (!accounted && error instanceof ModelResponseValidationError) {
            responseUsage = error.usage;
            aggregateUsage = mergeUsage(aggregateUsage, responseUsage);
            accounted = true;
            try {
              budget.recordUsage(responseUsage, error.cost);
            } catch (accountingError) {
              const latestCost = budget.snapshot().latestCost;
              failure = new ModelResponseValidationError(
                error.message,
                omitUndefined({
                  usage: responseUsage,
                  cost: latestCost,
                  cause: new AggregateError([error, accountingError], "Model validation and accounting failed", {
                    cause: error,
                  }),
                }),
              );
              if (accountingError instanceof RunBudgetExceededError)
                emit({
                  type: "run.budget.exceeded",
                  dimension: accountingError.dimension,
                  limit: accountingError.limit,
                  consumed: accountingError.consumed,
                  budget: budget.snapshot(),
                });
            }
          }
          if (accounted) {
            const snapshot = budget.snapshot();
            setTraceAttributes(modelSpan, {
              ...usageTraceAttributes(responseUsage, "may.model"),
              ...(snapshot.latestCost === undefined
                ? { "may.model.cost_complete": false }
                : costTraceAttributes(snapshot.latestCost)),
            });
          }
          endOperationSpan(modelSpan, failure, signal);
          await this.observe(runtimeHooks.modelFailed, { error: serializeError(failure) }, { runId, step, signal });
          throw failure;
        }
        const { message, usage } = modelResponse;

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
        await checkpoint?.(
          omitUndefined({ type: "model.completed", runId, step, message, contextMessageCount, usage }),
        );
        emit(omitUndefined({ type: "model.completed", step, message, contextMessageCount, usage }));
        const calls = message.toolCalls ?? [];
        if (calls.length > 0) pendingTools = { step, calls, outcomes: [], executions: [] };
        await this.observe(runtimeHooks.modelAfter, { message }, { runId, step, signal });
        if (calls.length === 0) {
          emit({ type: "step.completed", step });
          await this.observe(runtimeHooks.stepCompleted, { step }, { runId, step, signal });

          const result = createRunResult(runId, step, modelCalls, toolCalls, message, aggregateUsage);
          result.budget = budget.snapshot();
          if (shouldYield?.() === true) return await yieldRun(step, result);
          if (await this.receiveStepInput(stepInputSource, runId, step, signal, emit)) continue;
          const settlement = await this.transform(
            runtimeHooks.runBeforeEnd,
            { result, continueMessages: [] },
            { runId, step, signal },
          );
          if (!jsonEqual(settlement.result, result))
            throw new ModelProtocolError("Run settlement cannot change the completed result");
          throwIfAborted(signal);
          budget.checkTime();
          if (shouldYield?.() === true) return await yieldRun(step, result);
          if (settlement.continueMessages.length > 0) {
            const generated = {
              type: "input.generated" as const,
              runId,
              step,
              messages: [...settlement.continueMessages],
              reason: settlement.reason!,
            };
            await checkpoint?.(generated);
            try {
              await this.context.append(generated.messages, { runId, step });
            } catch (error) {
              this.unsafeToReuse = true;
              throw new RunCheckpointError(error);
            }
            emit(generated);
            continue;
          }
          await this.observe(runtimeHooks.runEnded, result, { runId, step, signal });
          emit({ type: "run.completed", result });
          return result;
        }

        budget.reserveTools(calls.length);
        toolCalls += calls.length;
        const batchSpan = startTraceSpan(
          this.tracer,
          "may.tools.batch",
          omitUndefined({
            parent: runTraceContext,
            attributes: {
              "may.step": step,
              "may.tool.call_count": calls.length,
            },
          }),
        );
        let outcomes: readonly ToolExecutionOutcome[];
        try {
          outcomes = await this.scheduleTools(
            tools,
            runId,
            step,
            calls,
            signal,
            emit,
            pendingTools!,
            batchSpan?.context,
            checkpoint,
          );
          const failedCount = outcomes.filter((outcome) => outcome.type === "failed").length;
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
          () =>
            this.context.append(
              outcomes.map((outcome) => outcome.message),
              { runId, step },
            ),
        );
        emitToolOutcomes(step, outcomes, emit);
        for (const outcome of outcomes) {
          fatal ??= outcome.fatal;
        }
        pendingTools = undefined;
        throwIfAborted(signal);
        if (fatal !== undefined) throw fatal;

        emit({ type: "step.completed", step });
        await this.observe(runtimeHooks.stepCompleted, { step }, { runId, step, signal });
        if (shouldYield?.() === true) {
          budget.checkTime();
          const result = createRunResult(runId, step, modelCalls, toolCalls, message, aggregateUsage);
          result.budget = budget.snapshot();
          return await yieldRun(step, result);
        }
        await this.receiveStepInput(stepInputSource, runId, step, signal, emit);
      }

      if (budget.limits.maxSteps !== undefined && budget.limits.maxSteps <= this.maxSteps)
        throw new RunBudgetExceededError("steps", budget.limits.maxSteps, this.maxSteps + 1);
      throw new MaxStepsExceededError(this.maxSteps);
    } catch (error) {
      const wasAborted = signal.aborted;
      if (pendingTools !== undefined) {
        abortPending(error);
        const settled = await settleWithin(
          pendingTools.executions.filter((value) => value !== undefined),
          this.toolSettleTimeoutMs,
        );
        pendingTools.closed = true;
        if (!settled) {
          this.unsafeToReuse = true;
          const failure = new RunCheckpointError(
            new Error("Tools did not settle before the cancellation deadline; external effects are unknown"),
          );
          emit({ type: "run.failed", error: serializeError(failure) });
          throw failure;
        }
        if (
          !wasAborted &&
          !(error instanceof RunCancelledError) &&
          !(error instanceof RunBudgetExceededError) &&
          !(error instanceof RunCheckpointError)
        ) {
          if (
            pendingTools.executions.some(
              (execution, index) => execution !== undefined && pendingTools!.outcomes[index] === undefined,
            )
          ) {
            this.unsafeToReuse = true;
            const failure = new RunCheckpointError(
              new Error("Tool execution ended without a known outcome; host reconciliation is required"),
            );
            emit({ type: "run.failed", error: serializeError(failure) });
            throw failure;
          }
          const outcomes = pendingTools.calls.map(
            (call, index) =>
              pendingTools!.outcomes[index] ??
              createSkippedToolOutcome(call, new FatalToolExecutionError(String(error))),
          );
          try {
            const snapshot = await this.context.snapshot();
            const assistantIndex = snapshot.messages.map((message) => message.role).lastIndexOf("assistant");
            const existing = new Set(
              snapshot.messages
                .slice(assistantIndex + 1)
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId),
            );
            await this.context.append(
              outcomes.filter((outcome) => !existing.has(outcome.call.id)).map((outcome) => outcome.message),
              { runId, step: pendingTools.step },
            );
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
      const budgetError =
        signal.reason instanceof RunBudgetExceededError
          ? signal.reason
          : error instanceof RunBudgetExceededError
            ? error
            : undefined;
      if (signal.aborted || error instanceof RunCancelledError) {
        const cancelled = error instanceof RunCancelledError ? error : new RunCancelledError(toReason(signal.reason));
        const reason = toReason(signal.reason);

        if (pendingTools !== undefined) {
          const settledOutcomes = pendingTools.outcomes.filter(
            (outcome): outcome is ToolExecutionOutcome => outcome !== undefined,
          );
          const cancellationOutcomes = pendingTools.calls.map(
            (call, index) => pendingTools?.outcomes[index] ?? createCancelledToolOutcome(call, cancelled),
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
          emit({
            type: "run.budget.exceeded",
            dimension: budgetError.dimension,
            limit: budgetError.limit,
            consumed: budgetError.consumed,
            budget: budget.snapshot(),
          });
          emit({ type: "run.failed", error: serializeError(budgetError) });
          throw budgetError;
        }
        emit(reason === undefined ? { type: "run.cancelled" } : { type: "run.cancelled", reason });
        throw cancelled;
      }

      if (budgetError !== undefined)
        emit({
          type: "run.budget.exceeded",
          dimension: budgetError.dimension,
          limit: budgetError.limit,
          consumed: budgetError.consumed,
          budget: budget.snapshot(),
        });
      emit({ type: "run.failed", error: serializeError(error) });
      throw error;
    }
  }

  private async receiveStepInput(
    source: StepInputSource | undefined,
    runId: string,
    step: number,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (source === undefined) return false;
    const messages = await source({ runId, step, signal });
    if (messages.length === 0) {
      throwIfAborted(signal);
      return false;
    }
    // 输入已经保存时，即使取消同时到达，也要完成 Context 更新以保持恢复一致。
    try {
      await this.context.append([...messages], { runId, step });
    } catch (error) {
      this.unsafeToReuse = true;
      throw new RunCheckpointError(error);
    }
    emit({ type: "input.received", step, messages: [...messages] });
    throwIfAborted(signal);
    return true;
  }

  private createModelRequest(snapshot: ContextSnapshot, tools: ToolRegistry): ModelRequest {
    return createModelRequest(snapshot, tools, this.responseFormat);
  }

  private async consumeModel(
    request: ModelRequest,
    signal: AbortSignal,
    runId: string,
    step: number,
    modelCallId: string,
    emit: (event: MayEventPayload) => void,
    modelSpan: TraceSpan | undefined,
    recordRequest: ModelRequestSink | undefined,
  ): Promise<{ message: AssistantMessage; usage?: Usage; cost?: UsageCost }> {
    return consumeModel(
      {
        model: this.model,
        tracer: this.tracer,
        observe: (hook, value, context) => this.observe(hook, value, context),
        requireReconciliation: () => {
          this.unsafeToReuse = true;
        },
      },
      request,
      signal,
      runId,
      step,
      modelCallId,
      emit,
      modelSpan,
      recordRequest,
    );
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
          execution ??= this.executeTool(tools, runId, step, call, signal, emit, batchTraceContext, checkpoint).then(
            async (outcome) => {
              if (pending.closed) return outcome;
              pending.outcomes[index] = outcome;
              await checkpoint?.(
                outcome.type === "completed"
                  ? {
                      type: "tool.completed",
                      runId,
                      step,
                      call,
                      output: outcome.output,
                      content: outcome.message.content,
                    }
                  : { type: "tool.failed", runId, step, call, error: outcome.error },
              );
              if (outcome.type === "completed" && outcome.fatal === undefined) {
                await this.observe(
                  runtimeHooks.toolAfter,
                  { call, output: outcome.output, content: outcome.message.content },
                  { runId, step, signal },
                );
              }
              return outcome;
            },
          );
          pending.executions[index] = execution;
          return execution;
        },
        isTerminal: (outcome: ToolExecutionOutcome) => outcome.fatal !== undefined,
      };
    });
    const outcomes = await abortable(this.toolScheduler.schedule(operations, { runId, step, signal }), signal);
    if (outcomes.length > calls.length) {
      throw new ToolSchedulerError(`Tool scheduler returned ${outcomes.length} results for ${calls.length} calls`);
    }
    for (let index = 0; index < outcomes.length; index++) {
      if (outcomes[index]?.call !== calls[index]) {
        throw new ToolSchedulerError("Tool scheduler must return results in call order");
      }
    }
    if (outcomes.length === calls.length) return outcomes;

    const terminal = outcomes.at(-1);
    if (terminal?.fatal === undefined) {
      throw new ToolSchedulerError(`Tool scheduler returned ${outcomes.length} results for ${calls.length} calls`);
    }

    const fatal = terminal.fatal;
    return [...outcomes, ...calls.slice(outcomes.length).map((call) => createSkippedToolOutcome(call, fatal))];
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
    throwIfAborted(signal);
    let active = true;
    let progressTail = Promise.resolve();
    let rawOutput: { readonly value: unknown; readonly content: ContentPart[] } | undefined;
    const toolSpan = startTraceSpan(
      this.tracer,
      "may.tool.call",
      omitUndefined({
        parent: parentTraceContext,
        attributes: {
          "may.step": step,
          "may.tool.name": call.name,
          "may.tool.call_id": call.id,
        },
      }),
    );

    try {
      const tool = tools.get(call.name);
      if (!tool) throw new ToolNotFoundError(call.name);

      const prepared = await this.transform(
        runtimeHooks.toolBefore,
        { call, input: call.input },
        { runId, step, signal },
      );
      if (prepared.call.id !== call.id || prepared.call.name !== call.name)
        throw new FatalToolExecutionError("Tool Hook cannot change call identity");
      if (prepared.denyReason !== undefined) throw new ToolHookDeniedError(prepared.denyReason);
      throwIfAborted(signal);
      const parsedInput = tool.parse ? await tool.parse(prepared.input) : prepared.input;
      throwIfAborted(signal);
      const input = freezeToolInput(parsedInput);
      await checkpoint?.({ type: "tool.started", runId, step, call, input });
      throwIfAborted(signal);
      emit({ type: "tool.started", step, call, input });
      const output = await this.toolExecutor.execute(
        Object.freeze({
          tool,
          input,
          context: omitUndefined({
            scope: this.runScopes.get(runId)!,
            runId,
            step,
            toolCallId: call.id,
            idempotencyKey: `${runId}:${step}:${call.id}`,
            signal,
            traceContext: toolSpan?.context,
            report: (update: ToolProgressUpdate) => {
              if (!active || signal.aborted) return;
              emitToolProgress(step, call, update, emit);
              const savedUpdate = structuredClone(update);
              progressTail = progressTail.then(() =>
                this.observe(runtimeHooks.toolProgress, { call, update: savedUpdate }, { runId, step, signal }),
              );
              void progressTail.catch(() => undefined);
            },
          }),
        }),
      );

      const originalContent: ContentPart[] = tool.resultContent?.(output) ?? [{ type: "json", value: output }];
      rawOutput = { value: output, content: originalContent };
      await progressTail;
      const projected = await this.transform(
        runtimeHooks.toolResult,
        { call, content: originalContent },
        { runId, step, signal },
      );
      if (projected.call.id !== call.id || projected.call.name !== call.name)
        throw new FatalToolExecutionError("Tool result Hook cannot change call identity");
      const content = [...projected.content];
      rawOutput = { value: output, content };
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
      if (rawOutput !== undefined) {
        endTraceSpan(toolSpan, { status: "error", error: traceError(error) });
        return {
          type: "completed",
          call,
          output: rawOutput.value,
          message: { role: "tool", toolCallId: call.id, name: call.name, content: rawOutput.content },
          fatal:
            error instanceof FatalToolExecutionError
              ? error
              : new FatalToolExecutionError(error instanceof Error ? error.message : String(error)),
        };
      }
      if (signal.aborted || error instanceof RunCancelledError) {
        endOperationSpan(toolSpan, error, signal);
        throw error;
      }

      const serialized = serializeError(error);
      await this.observe(runtimeHooks.toolFailed, { call, error: serialized }, { runId, step, signal });
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

  private async transform<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<T> {
    if (this.hooks === undefined) return value;
    try {
      return await this.hooks.transform(hook, value, context);
    } catch (error) {
      const failure = error instanceof HookExecutionError ? error : new HookExecutionError(error, hook.name);
      if (hook.name.startsWith("tool.")) throw new FatalToolExecutionError(failure.message, { cause: failure });
      throw failure;
    }
  }

  private async observe<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<void> {
    if (this.hooks === undefined) return;
    try {
      await this.hooks.observe(hook, value, context);
    } catch (error) {
      throw error instanceof HookExecutionError ? error : new HookExecutionError(error, hook.name);
    }
  }
}

function createRunId(): string {
  return `run_${randomUUID()}`;
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

async function settleWithin(pending: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new RunCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
