import type { AssistantMessage, ToolCall, Usage } from "./types.js";

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export interface RunResult {
  runId: string;
  steps: number;
  message: AssistantMessage;
  usage?: Usage;
}

export type MayEventPayload =
  | { type: "run.started"; continuation?: boolean }
  | { type: "step.started"; step: number }
  | { type: "step.completed"; step: number }
  | { type: "model.started"; step: number }
  | { type: "model.text.delta"; step: number; delta: string }
  | { type: "model.reasoning.delta"; step: number; delta: string }
  | {
      type: "model.retrying";
      step: number;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: SerializedError;
    }
  | {
      type: "model.completed";
      step: number;
      message: AssistantMessage;
      contextMessageCount: number;
      usage?: Usage;
    }
  | { type: "tool.started"; step: number; call: ToolCall }
  | {
      type: "tool.completed";
      step: number;
      call: ToolCall;
      output: unknown;
    }
  | {
      type: "tool.failed";
      step: number;
      call: ToolCall;
      error: SerializedError;
    }
  | { type: "run.completed"; result: RunResult }
  | { type: "run.failed"; error: SerializedError }
  | { type: "run.cancelled"; reason?: string };

export type MayEvent = MayEventPayload & {
  runId: string;
  seq: number;
  timestamp: number;
};

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const result: SerializedError = {
      name: error.name,
      message: error.message,
    };

    if ("code" in error && typeof error.code === "string") {
      result.code = error.code;
    }

    return result;
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "Unknown error",
  };
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
