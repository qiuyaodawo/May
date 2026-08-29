import type { RunOptions } from "@may/core";
import type {
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextInspection,
} from "@may/context";
import type { ApprovalDecision } from "@may/permissions";
import type { SessionEvent } from "@may/session";

import type { SessionSummary } from "./catalog.js";
import type { MaybeCodeEvent, MaybeCodeRun } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export interface MaybeCodeModelInfo {
  readonly provider: string;
  readonly model: string;
}

export type MaybeCodeCompactionStrategyName =
  | "prune-old-tool-results"
  | "summary-tail"
  | "history-reference";

export type MaybeCodeCompactionSelection =
  | MaybeCodeCompactionStrategyName
  | ContextCompactionStrategy;

/**
 * Headless MaybeCode control surface for terminal, graphical, or remote UIs.
 *
 * A UI sends user intents through these methods and observes asynchronous
 * runtime changes through `events`. It does not depend on readline, ANSI
 * rendering, or the concrete workspace implementation.
 */
export interface MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;
  readonly workspace: string;
  readonly sessionId: string;
  readonly isRunning: boolean;
  readonly instructions: MaybeCodeInstructions;
  readonly modelInfo: MaybeCodeModelInfo | undefined;

  submit(options: RunOptions): Promise<MaybeCodeRun>;
  retry(): Promise<MaybeCodeRun>;
  cancel(reason?: string): boolean;

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean>;

  listSessions(): Promise<readonly SessionSummary[]>;
  newSession(): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;

  history(): Promise<readonly SessionEvent[]>;
  inspectContext(): Promise<ContextInspection | undefined>;
  compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult>;

  close(): Promise<void>;
}
