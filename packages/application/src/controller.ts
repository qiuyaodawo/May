import type {
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextInspection,
} from "@may/context";
import type { RunOptions } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type {
  SessionEvent,
  SessionHistoryPage,
  SessionHistoryQuery,
} from "@may/session";
import type { SessionSummary } from "@may/session/catalog";

import type {
  AgentApplicationEvent,
  AgentRun,
  AgentWorkspaceEvent,
} from "./events.js";

/**
 * UI-independent control surface for one active May session.
 *
 * Applications may widen both the event and compaction-selection types while
 * retaining this lifecycle contract.
 */
export interface AgentController<
  Event = AgentApplicationEvent,
  CompactionSelection = ContextCompactionStrategy,
> {
  readonly events: AsyncIterable<Event>;
  readonly sessionId: string;
  readonly isRunning: boolean;

  submit(options: RunOptions): Promise<AgentRun>;
  retry(): Promise<AgentRun>;
  cancel(reason?: string): boolean;
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean>;
  history(): Promise<readonly SessionEvent[]>;
  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage>;
  inspectContext(): Promise<ContextInspection | undefined>;
  compactContext(
    selection?: CompactionSelection,
  ): Promise<ContextCompactionResult>;
  close(): Promise<void>;
}

/** Headless control surface for applications that expose multiple sessions. */
export interface AgentWorkspaceController<
  ApplicationEvent = AgentApplicationEvent,
  ExtensionEvent = never,
  CompactionSelection = ContextCompactionStrategy,
> extends AgentController<
    AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>,
    CompactionSelection
  > {
  readonly workspace: string;

  listSessions(): Promise<readonly SessionSummary[]>;
  newSession(): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;
}
