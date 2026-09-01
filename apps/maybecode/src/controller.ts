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
  readonly profile?: string;
  readonly provider: string;
  readonly adapter?: string;
  readonly model: string;
}

export interface MaybeCodeModelProfile {
  readonly name: string;
  readonly provider: string;
  readonly adapter: string;
  readonly model: string;
  readonly isDefault: boolean;
  /** Effort configured by provider/model options before runtime overrides. */
  readonly reasoningEffort?: string;
}

export interface MaybeCodeReasoningEffortState {
  readonly status: "known" | "unsupported" | "unknown";
  readonly source: "user" | "provider" | "builtin" | "unknown";
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly effectiveEffort?: string;
  readonly overridden: boolean;
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
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;

  listModels(): Promise<readonly MaybeCodeModelProfile[]>;
  switchModel(profile: string): Promise<MaybeCodeModelInfo>;
  /** Persist the profile used by future launches without switching models. */
  setDefaultModel(profile: string): Promise<void>;
  getReasoningEffort(): Promise<MaybeCodeReasoningEffortState>;
  /** Set an active-profile override, or clear it with undefined. */
  setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState>;

  history(): Promise<readonly SessionEvent[]>;
  inspectContext(): Promise<ContextInspection | undefined>;
  compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult>;

  close(): Promise<void>;
}
