import type { MayEvent, RunResult, SerializedError } from "@may/core";
import type { ContextInspection } from "@may/context";
import type { PermissionEvent } from "@may/permissions";
import type { ToolChangePreview } from "./diff.js";

export type MaybeCodeSessionEvent =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent }
  | {
      type: "change.preview";
      runId: string;
      step: number;
      toolCallId: string;
      preview: ToolChangePreview;
    }
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

export type MaybeCodeEvent =
  | MaybeCodeSessionEvent
  | {
      type: "session.changed";
      sessionId: string;
      resumed: boolean;
    };

export interface MaybeCodeRun {
  readonly id: string;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): void;
}
