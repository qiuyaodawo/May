import type { MayEvent, RunResult } from "@may/core";
import type { PermissionEvent } from "@may/permissions";

export type MaybeCodeSessionEvent =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent };

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
