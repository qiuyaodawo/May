import type { JsonSchema } from "./types.js";

export interface ToolExecutionContext {
  runId: string;
  turn: number;
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
