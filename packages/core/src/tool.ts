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
  /** Trusted host routing labels, never derived from model/tool arguments. */
  readonly scope?: Readonly<Record<string, string>>;
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

export function freezeToolInput<T>(input: T): T {
  const visited = new WeakSet<object>();
  const values: object[] = [];
  const visit = (value: unknown): void => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (visited.has(value)) return;
    if (
      value instanceof Date || value instanceof Map || value instanceof Set ||
      value instanceof WeakMap || value instanceof WeakSet ||
      value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
      (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) ||
      value instanceof URL || value instanceof URLSearchParams
    ) {
      throw new TypeError(`Tool input cannot contain mutable built-in ${Object.prototype.toString.call(value)}; use immutable data fields`);
    }
    visited.add(value);
    values.push(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) visit(descriptor.value);
    }
  };
  visit(input);
  for (const value of values.reverse()) Object.freeze(value);
  return input;
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
  async schedule<T>(operations: readonly ToolOperation<T>[], context: ToolSchedulingContext): Promise<T[]> {
    context.signal.throwIfAborted();
    return Promise.all(operations.map((operation) => { context.signal.throwIfAborted(); return operation.execute(); }));
  },
};
