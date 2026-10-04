import type {
  AssistantMessage,
  ContentPart,
  Message,
  RunResult,
  SerializedError,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  Usage,
  UserMessage,
  RunBudgetSnapshot,
  RuntimeDescriptor,
} from "@may/core";
import type { SessionSteeringInput } from "./steering.js";

export interface SessionRecovery {
  readonly id: string;
  readonly runId: string;
  readonly step: number;
  readonly call: ToolCall;
  readonly status: "unknown" | "not-started";
}

export interface SessionForkOrigin {
  readonly sessionId: string;
  readonly positionSeq: number;
  readonly runId: string;
}

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

/**
 * Durable, application-owned display metadata associated with a tool call.
 * Session stores and exposes this event, but does not replay it into model context.
 */
export interface SessionToolPresentation {
  readonly runId: string;
  readonly step: number;
  readonly toolCallId: string;
  readonly kind: string;
  readonly version: number;
  readonly data: unknown;
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
  | { type: "state.updated"; key: string; value: unknown }
  | { type: "run.budget.exceeded"; runId: string; dimension: string; limit: number; consumed: number; budget: RunBudgetSnapshot }
  | { type: "session.created"; metadata?: Record<string, unknown>; runtime?: RuntimeDescriptor; fork?: SessionForkOrigin }
  | { type: "session.fork.ready" }
  | { type: "history.omitted"; reason: "permission" | "unconsumed-input" | "application-state" | "fork-initialization" }
  | { type: "runtime.state.saved"; runtime: RuntimeDescriptor; state: unknown }
  | { type: "runtime.changed"; runtime: RuntimeDescriptor; state?: unknown }
  | { type: "input.generated"; runId: string; step: number; messages: readonly UserMessage[]; reason: string }
  | { type: "input.submitted"; message: UserMessage; inputId?: string }
  | { type: "input.steering.queued"; input: SessionSteeringInput }
  | { type: "input.steering.delivered"; runId: string; step: number; inputIds: readonly string[] }
  | { type: "input.steering.finished"; inputIds: readonly string[]; status: "idle" | "cancelled"; reason: string }
  | { type: "run.started"; runId: string; continuation?: boolean; checkpointVersion?: 1 }
  | { type: "run.settled"; runId: string; hostCompleted?: true }
  | { type: "tool.started"; runId: string; step: number; call: ToolCall; input?: unknown }
  | { type: "run.interrupted"; runId: string; recoveries: readonly SessionRecovery[] }
  | { type: "recovery.resolved"; recoveryId: string; message: UserMessage }
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
      /** 旧记录可能缺少本次执行的模型可见内容。 */
      content?: ContentPart[];
    }
  | {
      type: "tool.failed";
      runId: string;
      step: number;
      call: ToolCall;
      error: SerializedError;
    }
  | ({ type: "tool.presentation" } & SessionToolPresentation)
  | { type: "approval.requested"; request: SessionApprovalRequest }
  | {
      type: "approval.resolved";
      requestId: string;
      decision: SessionApprovalDecision;
    }
  | { type: "approval.cancelled"; requestId: string; reason?: string }
  | { type: "run.completed"; runId: string; result: RunResult }
  | { type: "run.yielded"; runId: string; result: RunResult }
  | { type: "run.failed"; runId: string; error: SerializedError }
  | { type: "run.cancelled"; runId: string; reason?: string };

export type SessionEvent = SessionEventPayload & {
  sessionId: string;
  seq: number;
  timestamp: number;
};

/** 旧记录的原始输出保留给 host，模型读取明确的缺失提示。 */
export function sessionToolResultContent(
  event: Extract<SessionEventPayload, { type: "tool.completed" }>,
): ContentPart[] {
  return event.content === undefined
    ? [{ type: "text", text: "This historical tool result has no saved model-visible content. The original output is available only to the host." }]
    : structuredClone(event.content);
}
