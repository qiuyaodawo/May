import type { JsonSchema } from "./types.js";

export interface ToolExecutionContext {
  runId: string;
  step: number;
  toolCallId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;

  /** Optional runtime validation/coercion hook. Throw to reject the input. */
  parse?(input: unknown): TInput;

  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
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

export const directToolExecutor: ToolExecutor = {
  execute({ tool, input, context }) {
    return tool.execute(input, context);
  },
};
