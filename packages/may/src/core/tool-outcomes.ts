import { FatalToolExecutionError, RunCancelledError } from "./errors.js";
import { serializeError, type MayEventPayload, type SerializedError } from "./events.js";
import type { ToolProgressUpdate } from "./tool.js";
import { toolCancellationMessage, type ToolCall, type ToolMessage } from "./types.js";

interface CompletedToolExecution {
  readonly type: "completed";
  readonly call: ToolCall;
  readonly output: unknown;
  readonly message: ToolMessage;
  readonly fatal?: FatalToolExecutionError;
}

export interface FailedToolExecution {
  readonly type: "failed";
  readonly call: ToolCall;
  readonly error: SerializedError;
  readonly message: ToolMessage;
  fatal?: FatalToolExecutionError;
}

export type ToolExecutionOutcome = CompletedToolExecution | FailedToolExecution;

export function createCancelledToolOutcome(call: ToolCall, error: RunCancelledError): FailedToolExecution {
  return { type: "failed", call, error: serializeError(error), message: toolCancellationMessage(call, error.message) };
}

export function createSkippedToolOutcome(call: ToolCall, fatal: FatalToolExecutionError): FailedToolExecution {
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

export function emitToolOutcomes(
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
        content: outcome.message.content,
      });
    } else {
      emit({ type: "tool.failed", step, call: outcome.call, error: outcome.error });
    }
  }
}

export function emitToolProgress(
  step: number,
  call: ToolCall,
  update: ToolProgressUpdate,
  emit: (event: MayEventPayload) => void,
): void {
  if (update.type === "output.delta") {
    if (typeof update.delta !== "string") throw new TypeError("Tool output delta must be a string");
    if (update.delta === "") return;
    emit(
      update.channel === undefined
        ? { type: "tool.output.delta", step, call, delta: update.delta }
        : { type: "tool.output.delta", step, call, delta: update.delta, channel: update.channel },
    );
    return;
  }
  if (update.type !== "progress" || typeof update.message !== "string")
    throw new TypeError("Tool progress update is invalid");
  emit(
    update.data === undefined
      ? { type: "tool.progress", step, call, message: update.message }
      : { type: "tool.progress", step, call, message: update.message, data: update.data },
  );
}
