import type { ContextInspection } from "@may/context";
import type {
  MayEvent,
  RunResult,
  SerializedError,
  TraceContext,
} from "@may/core";
import type { PermissionEvent } from "@may/permissions";
import type { SessionToolPresentation } from "@may/session";

/** Events shared by headless May applications, regardless of their UI. */
export type AgentApplicationEvent =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent }
  | { type: "tool.presentation"; presentation: SessionToolPresentation }
  | {
      type: "context.compacted";
      strategy: string;
      before: ContextInspection;
      after: ContextInspection;
    }
  | {
      type: "context.compaction.failed";
      strategy: string;
      automatic: true;
      error: SerializedError;
      continuing: boolean;
      before: ContextInspection;
    };

export interface AgentRun {
  readonly id: string;
  readonly result: Promise<RunResult>;
  readonly traceContext?: TraceContext;
  cancel(reason?: string): void;
}

export interface AgentSessionChangedEvent {
  readonly type: "session.changed";
  readonly sessionId: string;
  readonly resumed: boolean;
}

export type AgentWorkspaceEvent<
  ApplicationEvent = AgentApplicationEvent,
  ExtensionEvent = never,
> = ApplicationEvent | AgentSessionChangedEvent | ExtensionEvent;
