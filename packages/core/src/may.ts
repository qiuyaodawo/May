import type { Context, ContextSnapshot } from "./context.js";
import {
  MaxStepsExceededError,
  ModelProtocolError,
  RunCancelledError,
  ToolNotFoundError,
} from "./errors.js";
import {
  AsyncEventQueue,
  serializeError,
  type MayEvent,
  type MayEventPayload,
  type RunResult,
} from "./events.js";
import type { Model, ModelRequest, ToolDefinition } from "./model.js";
import {
  directToolExecutor,
  type Tool,
  type ToolExecutor,
} from "./tool.js";
import {
  textContent,
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
  tools?: Tool[];
  context: Context;
  maxSteps?: number;
  toolExecutor?: ToolExecutor;
}

export interface RunOptions {
  input: string | UserMessage;
  signal?: AbortSignal;
}

export interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<MayEvent>;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): void;
}

export class May {
  private readonly model: Model;
  private readonly context: Context;
  private readonly tools: ReadonlyMap<string, Tool>;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly maxSteps: number;
  private readonly toolExecutor: ToolExecutor;

  constructor(options: MayOptions) {
    const maxSteps = options.maxSteps ?? 16;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError("maxSteps must be a positive integer");
    }

    const tools = new Map<string, Tool>();
    for (const tool of options.tools ?? []) {
      if (tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    }

    this.model = options.model;
    this.context = options.context;
    this.tools = tools;
    this.toolDefinitions = [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    this.maxSteps = maxSteps;
    this.toolExecutor = options.toolExecutor ?? directToolExecutor;
  }

  run(options: RunOptions): RunHandle {
    const runId = createRunId();
    const events = new AsyncEventQueue<MayEvent>();
    const controller = new AbortController();
    let seq = 0;

    const onExternalAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      onExternalAbort();
    } else {
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const emit = (payload: MayEventPayload): void => {
      events.push({
        ...payload,
        runId,
        seq: ++seq,
        timestamp: Date.now(),
      });
    };

    const input = typeof options.input === "string"
      ? userMessage(options.input)
      : options.input;

    const result = this.execute(runId, input, controller.signal, emit)
      .finally(() => {
        options.signal?.removeEventListener("abort", onExternalAbort);
        events.close();
      });

    // Avoid an unhandled-rejection warning when a caller only consumes events.
    void result.catch(() => undefined);

    return {
      id: runId,
      events,
      result,
      cancel: (reason?: string) => controller.abort(reason),
    };
  }

  private async execute(
    runId: string,
    input: UserMessage,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
  ): Promise<RunResult> {
    try {
      emit({ type: "run.started" });
      throwIfAborted(signal);
      await this.context.append([input], { runId });

      for (let step = 1; step <= this.maxSteps; step++) {
        throwIfAborted(signal);
        emit({ type: "step.started", step });

        const snapshot = await this.context.snapshot({
          runId,
          step,
          signal,
        });
        const request = this.createModelRequest(snapshot);

        emit({ type: "model.started", step });
        const { message, usage } = await this.consumeModel(
          request,
          signal,
          step,
          emit,
        );

        throwIfAborted(signal);
        await this.context.append([message], { runId, step });
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

          const result = createRunResult(runId, step, message, usage);
          emit({ type: "run.completed", result });
          return result;
        }

        for (const call of calls) {
          throwIfAborted(signal);
          const toolMessage = await this.executeTool(
            runId,
            step,
            call,
            signal,
            emit,
          );

          throwIfAborted(signal);
          await this.context.append([toolMessage], { runId, step });
        }

        emit({ type: "step.completed", step });
      }

      throw new MaxStepsExceededError(this.maxSteps);
    } catch (error) {
      if (signal.aborted || error instanceof RunCancelledError) {
        const cancelled = error instanceof RunCancelledError
          ? error
          : new RunCancelledError(toReason(signal.reason));
        const reason = toReason(signal.reason);

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

    const request: ModelRequest = {
      messages,
      tools: this.toolDefinitions,
    };

    if (snapshot.metadata !== undefined) {
      request.metadata = snapshot.metadata;
    }

    return request;
  }

  private async consumeModel(
    request: ModelRequest,
    signal: AbortSignal,
    step: number,
    emit: (event: MayEventPayload) => void,
  ): Promise<{ message: AssistantMessage; usage?: Usage }> {
    let completed: AssistantMessage | undefined;
    let usage: Usage | undefined;

    for await (const event of this.model.stream(request, { signal })) {
      throwIfAborted(signal);

      if (event.type === "text.delta") {
        emit({ type: "model.text.delta", step, delta: event.delta });
        continue;
      }

      if (event.type === "reasoning.delta") {
        emit({ type: "model.reasoning.delta", step, delta: event.delta });
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

  private async executeTool(
    runId: string,
    step: number,
    call: ToolCall,
    signal: AbortSignal,
    emit: (event: MayEventPayload) => void,
  ): Promise<ToolMessage> {
    emit({ type: "tool.started", step, call });

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
        },
      });

      throwIfAborted(signal);
      emit({ type: "tool.completed", step, call, output });

      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: [{ type: "json", value: output }],
      };
    } catch (error) {
      if (signal.aborted || error instanceof RunCancelledError) throw error;

      const serialized = serializeError(error);
      emit({ type: "tool.failed", step, call, error: serialized });

      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        isError: true,
        content: [{ type: "json", value: serialized }],
      };
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
  message: AssistantMessage,
  usage: Usage | undefined,
): RunResult {
  const result: RunResult = { runId, steps, message };
  if (usage !== undefined) result.usage = usage;
  return result;
}

function emitOptionalUsage(
  emit: (event: MayEventPayload) => void,
  event: Extract<MayEventPayload, { type: "model.completed" }>,
  usage: Usage | undefined,
): void {
  emit(usage === undefined ? event : { ...event, usage });
}
