import type { MayEvent, RunResult } from "@may/core";
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
