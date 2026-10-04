import type {
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextInspection,
} from "@may/context";
import type { ApprovalDecision, ApprovalResolveOptions, CreatePermissionRuleOptions, PermissionCheck, PersistentPermissionRule } from "@may/permissions";
import type {
  SessionEvent,
  SessionContinueOptions,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionRecovery,
  SessionSubmitOptions,
  SessionSteerOptions,
  SessionSteeringInput,
  SessionBranchPosition,
  SessionBranchNode,
} from "@may/session";
import type { SessionSummary } from "@may/session/catalog";
import type { AnyPlugin } from "@may/plugin";
import type { PluginUpdateOptions } from "./plugins.js";

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
  Run extends AgentRun = AgentRun,
> {
  readonly events: AsyncIterable<Event>;
  readonly sessionId: string;
  readonly isRunning: boolean;

  submit(options: SessionSubmitOptions): Promise<Run>;
  retry(): Promise<Run>;
  cancel(reason?: string): boolean;
  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: ApprovalResolveOptions,
  ): Promise<boolean>;
  listPermissionRules?(scopeId?: string): Promise<readonly PersistentPermissionRule[]>;
  createPermissionRule?(check: PermissionCheck, options: CreatePermissionRuleOptions): Promise<PersistentPermissionRule>;
  createPermissionRuleFrom?(sourceId: string, options: CreatePermissionRuleOptions): Promise<PersistentPermissionRule>;
  revokePermissionRule?(id: string): Promise<boolean>;
  history(): Promise<readonly SessionEvent[]>;
  branchPositions?(): Promise<readonly SessionBranchPosition[]>;
  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage>;
  listRecoveries?(): readonly SessionRecovery[];
  resolveRecovery?(id: string, finding: string): Promise<void>;
  inspectContext(): Promise<ContextInspection | undefined>;
  compactContext(
    selection?: CompactionSelection,
  ): Promise<ContextCompactionResult>;
  close(): Promise<void>;
  updatePlugins?(plugins: readonly AnyPlugin[], options?: PluginUpdateOptions): Promise<void>;
}

/** Headless control surface for applications that expose multiple sessions. */
export interface AgentWorkspaceController<
  ApplicationEvent = AgentApplicationEvent,
  ExtensionEvent = never,
  CompactionSelection = ContextCompactionStrategy,
  Run extends AgentRun = AgentRun,
> extends AgentController<
    AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>,
    CompactionSelection,
    Run
  > {
  readonly workspace: string;

  listSessions(): Promise<readonly SessionSummary[]>;
  /** Optional read-only history access; must not activate or repair the session. */
  readSessionHistory?(sessionId: string): Promise<readonly SessionEvent[]>;
  readSessionBranchTree?(): Promise<readonly SessionBranchNode[]>;
  forkSession?(sourceId: string, positionSeq: number, options?: import("./workspace.js").AgentWorkspaceForkOptions): Promise<string>;
  newSession(): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;
}

/** 可以在当前上下文中继续执行的通用控制接口。 */
export interface ContinuableAgentController extends AgentController {
  continue(options?: SessionContinueOptions): Promise<AgentRun>;
}

/** 支持持久化 Step 边界补充输入的控制接口。 */
export interface SteerableAgentController extends ContinuableAgentController {
  steer(options: SessionSteerOptions): Promise<SessionSteeringInput>;
  listSteeringInputs(): readonly SessionSteeringInput[];
  cancelSteeringInputs(reason?: string): Promise<void>;
  startSteeringInput(inputId: string, options?: Omit<SessionSubmitOptions, "input" | "inputId">): Promise<AgentRun>;
}
