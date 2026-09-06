import type { ContentPart, JsonSchema, ToolCall } from "./types.js";
import type { TraceContext } from "./tracing.js";

export type ToolProgressUpdate =
  | {
      type: "output.delta";
      delta: string;
      /** Optional output channel such as stdout or stderr. */
      channel?: string;
    }
  | {
      type: "progress";
      message: string;
      data?: unknown;
    };

export interface ToolExecutionContext {
  runId: string;
  step: number;
  toolCallId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  /** Current tool-call span for explicitly propagated instrumentation. */
  traceContext?: TraceContext;
  /** Emits live, non-durable progress while the tool is active. */
  report(update: ToolProgressUpdate): void;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Host-owned identity/version for grants, never sent to the model. */
  readonly permissionVersion?: string;

  /** Optional runtime validation/coercion hook. Throw to reject the input. */
  parse?(input: unknown): TInput;

  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;

  /** Optional model-visible projection; raw output remains in tool events. */
  resultContent?(output: TOutput): ContentPart[];
}

export interface ToolExecution<TInput = unknown, TOutput = unknown> {
  readonly tool: Tool<TInput, TOutput>;
  readonly input: TInput;
  readonly context: ToolExecutionContext;
}

export interface ToolExecutor {
  execute<TInput, TOutput>(
    execution: ToolExecution<TInput, TOutput>,
  ): Promise<TOutput>;
}

export interface ToolOperation<T> {
  readonly call: ToolCall;
  readonly tool: Tool | undefined;
  execute(): Promise<T>;
  /** Stop a sequential batch after this result without starting later tools. */
  isTerminal?(result: T): boolean;
}

export interface ToolSchedulingContext {
  readonly runId: string;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface ToolScheduler {
  schedule<T>(
    operations: readonly ToolOperation<T>[],
    context: ToolSchedulingContext,
  ): Promise<readonly T[]>;
}

export const directToolExecutor: ToolExecutor = {
  execute({ tool, input, context }) {
    return tool.execute(input, context);
  },
};

export const sequentialToolScheduler: ToolScheduler = {
  async schedule<T>(
    operations: readonly ToolOperation<T>[],
    context: ToolSchedulingContext,
  ): Promise<T[]> {
    const results: T[] = [];
    for (const operation of operations) {
      context.signal.throwIfAborted();
      const result = await operation.execute();
      results.push(result);
      if (operation.isTerminal?.(result) === true) break;
    }
    return results;
  },
};

/** Use only when every selected tool is safe to run concurrently. */
export const parallelToolScheduler: ToolScheduler = {
  schedule<T>(operations: readonly ToolOperation<T>[]): Promise<T[]> {
    return Promise.all(operations.map((operation) => operation.execute()));
  },
};
