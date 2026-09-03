import type { Context, ContextSnapshot } from "./context.js";
import {
  ConcurrentRunError,
  FatalToolExecutionError,
  MaxStepsExceededError,
  ModelProtocolError,
  RunCancelledError,
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
  context: Context;
  maxSteps?: number;
  toolExecutor?: ToolExecutor;
  toolScheduler?: ToolScheduler;
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
  input: string | UserMessage;
  signal?: AbortSignal;
  /** Optional parent span for explicit cross-component propagation. */
  traceContext?: TraceContext;
  /** Content-free attributes added to this Run span. */
  traceAttributes?: TraceAttributes;
}

export interface ContinueOptions {
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

export class May {
  private readonly model: Model;
  private readonly context: Context;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly toolExecutor: ToolExecutor;
  private readonly toolScheduler: ToolScheduler;
  private readonly concurrentRuns: "reject" | "allow";
  private readonly maxBufferedEvents: number;
  private readonly tracer: Tracer | undefined;
  private readonly traceAttributes: TraceAttributes;
  private activeRuns = 0;

  constructor(options: MayOptions) {
    const maxSteps = options.maxSteps ?? 16;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError("maxSteps must be a positive integer");
    }

    const tools = new ToolRegistry(options.tools);

    this.model = options.model;
    this.context = options.context;
    this.tools = tools;
    this.maxSteps = maxSteps;
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
    );
  }

  /** Continue from the existing context without appending a user message. */
  continue(options: ContinueOptions = {}): RunHandle {
    return this.start(
      undefined,
      options.signal,
      options.traceContext,
      options.traceAttributes,
    );
  }

  private start(
    input: UserMessage | undefined,
    externalSignal: AbortSignal | undefined,
    parentTraceContext: TraceContext | undefined,
    runTraceAttributes: TraceAttributes | undefined,
  ): RunHandle {
    if (this.concurrentRuns === "reject" && this.activeRuns > 0) {
      throw new ConcurrentRunError();
    }
    this.activeRuns += 1;
    const runId = createRunId();
    const events = new AsyncEventQueue<MayEvent>({
      maxBufferedValues: this.maxBufferedEvents,
      isDroppable: isStreamingMayEvent,
    });
    const controller = new AbortController();
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

    const result = this.execute(
      runId,
      input,
      controller.signal,
      emit,
      runSpan?.context,
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
        this.activeRuns -= 1;
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
    runId: string,
    input: UserMessage | undefined,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    runTraceContext: TraceContext | undefined,
  ): Promise<RunResult> {
    let aggregateUsage: Usage | undefined;
    let modelCalls = 0;
    let toolCalls = 0;
    let pendingTools: {
      readonly step: number;
      readonly calls: readonly ToolCall[];
      readonly outcomes: Array<ToolExecutionOutcome | undefined>;
      readonly executions: Array<Promise<ToolExecutionOutcome> | undefined>;
    } | undefined;
    try {
      emit(input === undefined
        ? { type: "run.started", continuation: true }
        : { type: "run.started" });
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

      for (let step = 1; step <= this.maxSteps; step++) {
        throwIfAborted(signal);
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
        const request = this.createModelRequest(snapshot);

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
          emit({ type: "run.completed", result });
          return result;
        }

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
            runId,
            step,
            calls,
            signal,
            emit,
            pendingTools,
            batchSpan?.context,
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
      }

      throw new MaxStepsExceededError(this.maxSteps);
    } catch (error) {
      if (signal.aborted || error instanceof RunCancelledError) {
        const cancelled = error instanceof RunCancelledError
          ? error
          : new RunCancelledError(toReason(signal.reason));
        const reason = toReason(signal.reason);

        if (pendingTools !== undefined) {
          await Promise.allSettled(
            pendingTools.executions.filter(
              (execution): execution is Promise<ToolExecutionOutcome> =>
                execution !== undefined,
            ),
          );
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
          emitToolOutcomes(pendingTools.step, settledOutcomes, emit);
          pendingTools = undefined;
        }

        emit(reason === undefined
          ? { type: "run.cancelled" }
          : { type: "run.cancelled", reason });
        throw cancelled;
      }

      emit({ type: "run.failed", error: serializeError(error) });
      throw error;
    }
  }

  private createModelRequest(snapshot: ContextSnapshot): ModelRequest {
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
      tools: this.tools.definitions(),
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
    runId: string,
    step: number,
    calls: readonly ToolCall[],
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    pending: {
      readonly outcomes: Array<ToolExecutionOutcome | undefined>;
      readonly executions: Array<Promise<ToolExecutionOutcome> | undefined>;
    },
    batchTraceContext: TraceContext | undefined,
  ): Promise<readonly ToolExecutionOutcome[]> {
    const operations = calls.map((call, index) => {
      let execution: Promise<ToolExecutionOutcome> | undefined;
      return {
        call,
        tool: this.tools.get(call.name),
        execute: () => {
          execution ??= this.executeTool(
            runId,
            step,
            call,
            signal,
            emit,
            batchTraceContext,
          )
            .then((outcome) => {
              pending.outcomes[index] = outcome;
              return outcome;
            });
          pending.executions[index] = execution;
          return execution;
        },
        isTerminal: (outcome: ToolExecutionOutcome) =>
          outcome.type === "failed" && outcome.fatal !== undefined,
      };
    });
    const outcomes = await this.toolScheduler.schedule(operations, {
      runId,
      step,
      signal,
    });
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
    runId: string,
    step: number,
    call: ToolCall,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
    parentTraceContext: TraceContext | undefined,
  ): Promise<ToolExecutionOutcome> {
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
      const tool = this.tools.get(call.name);
      if (!tool) throw new ToolNotFoundError(call.name);

      const input = tool.parse ? tool.parse(call.input) : call.input;
      const output = await this.toolExecutor.execute({
        tool,
        input,
        context: {
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

      endTraceSpan(toolSpan, { status: "ok" });
      return {
        type: "completed",
        call,
        output,
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: [{ type: "json", value: output }],
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
