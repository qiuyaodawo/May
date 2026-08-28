import type {
  AssistantMessage,
  Message,
  RunResult,
  SerializedError,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  Usage,
  UserMessage,
} from "@may/core";

export type SessionApprovalDecision = "allow" | "allow-session" | "deny";

export interface SessionApprovalRequest {
  id: string;
  createdAt: number;
  tool: ToolDefinition;
  input: unknown;
  runId: string;
  step: number;
  toolCallId: string;
  idempotencyKey: string;
  grantKey?: string;
}

export interface SessionContextCompaction {
  readonly strategy: string;
  readonly messages: readonly Message[];
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly beforeEstimatedTokens: number;
  readonly afterEstimatedTokens: number;
}

export type RecordablePermissionEvent = (
  | {
      type: "approval.requested";
      request: {
        id: string;
        createdAt: number;
        tool: ToolDefinition;
        input: unknown;
        context: ToolExecutionContext;
        grantKey?: string;
      };
    }
  | {
      type: "approval.resolved";
      requestId: string;
      decision: SessionApprovalDecision;
    }
  | { type: "approval.cancelled"; requestId: string; reason?: string }
) & { timestamp: number };

export type SessionEventPayload =
  | { type: "session.created"; metadata?: Record<string, unknown> }
  | { type: "input.submitted"; message: UserMessage }
  | { type: "run.started"; runId: string }
  | {
      type: "context.compacted";
      strategy: string;
      messages: Message[];
      beforeMessageCount: number;
      afterMessageCount: number;
      beforeEstimatedTokens: number;
      afterEstimatedTokens: number;
    }
  | {
      type: "assistant.completed";
      runId: string;
      step: number;
      message: AssistantMessage;
      usage?: Usage;
      contextMessageCount?: number;
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
  | { type: "approval.requested"; request: SessionApprovalRequest }
  | {
      type: "approval.resolved";
      requestId: string;
      decision: SessionApprovalDecision;
    }
  | { type: "approval.cancelled"; requestId: string; reason?: string }
  | { type: "run.completed"; runId: string; result: RunResult }
  | { type: "run.failed"; runId: string; error: SerializedError }
  | { type: "run.cancelled"; runId: string; reason?: string };

export type SessionEvent = SessionEventPayload & {
  sessionId: string;
  seq: number;
  timestamp: number;
};
