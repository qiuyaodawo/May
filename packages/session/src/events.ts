import type {
  AssistantMessage,
  RunResult,
  SerializedError,
  ToolCall,
  Usage,
  UserMessage,
} from "@may/core";

export type SessionEventPayload =
  | { type: "session.created"; metadata?: Record<string, unknown> }
  | { type: "input.submitted"; message: UserMessage }
  | { type: "run.started"; runId: string }
  | {
      type: "assistant.completed";
      runId: string;
      step: number;
      message: AssistantMessage;
      usage?: Usage;
    }
  | {
      type: "tool.completed";
      runId: string;
      step: number;
      call: ToolCall;
      output: unknown;
    }
  | {
      type: "tool.failed";
      runId: string;
      step: number;
      call: ToolCall;
      error: SerializedError;
    }
  | { type: "run.completed"; runId: string; result: RunResult }
  | { type: "run.failed"; runId: string; error: SerializedError }
  | { type: "run.cancelled"; runId: string; reason?: string };

export type SessionEvent = SessionEventPayload & {
  sessionId: string;
  seq: number;
  timestamp: number;
};
