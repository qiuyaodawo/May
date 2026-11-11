import type { AgentStateTransitionOptions, AgentWorkspaceController } from "@sortedyuan/may";
import type { GoalBudget, GoalState } from "@sortedyuan/may/goals";
import type { MaybeCodeApplication } from "./application.js";
import type { ContextCompactionStrategy } from "@sortedyuan/may/context";
import type { McpClientPool, McpServerStatus, McpResourceSubscription, McpInteractionBroker } from "@sortedyuan/mcp";
import type { MaybeCodeEvent, MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import type { SkillDescriptor, SkillDocument } from "@sortedyuan/may/skills";
import type { MaybeCodePermissionMode } from "./policy.js";
import type { UiForkPoint, UiWorkspaceGit, UiCheckpoint, UiWorktree, UiWorkspaceDiff } from "@sortedyuan/ui-client";

/** @experimental */
export interface MaybeCodeSkillInfo extends SkillDescriptor {
  readonly active: boolean;
}

/** @experimental */
export interface MaybeCodeModelInfo {
  readonly searchStatus?: string;
  readonly profile?: string;
  readonly provider: string;
  readonly adapter?: string;
  readonly model: string;
}

/** @experimental */
export interface MaybeCodeModelProfile {
  readonly searchStatus?: string;
  readonly name: string;
  readonly provider: string;
  readonly adapter: string;
  readonly model: string;
  readonly isDefault: boolean;
  /** Effort configured by provider/model options before runtime overrides. */
  readonly reasoningEffort?: string;
}

/** @experimental */
export interface MaybeCodeReasoningEffortState {
  readonly status: "known" | "unsupported" | "unknown";
  readonly source: "user" | "provider" | "builtin" | "adapter" | "unknown";
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly effectiveEffort?: string;
  readonly overridden: boolean;
}

/** @experimental */
export type MaybeCodeAutoCompactionMode = "prune-summary" | "history-reference" | "provider-native";

/** @experimental */
export type MaybeCodeCompactionStrategyName =
  "prune-old-tool-results" | "summary-tail" | "history-reference" | "provider-native";

/** @experimental */
export type MaybeCodeCompactionSelection = MaybeCodeCompactionStrategyName | ContextCompactionStrategy;

/**
 * Headless MaybeCode control surface for terminal, graphical, or remote UIs.
 *
 * A UI sends user intents through these methods and observes asynchronous
 * runtime changes through `events`. It does not depend on readline, ANSI
 * rendering, or the concrete workspace implementation.
 */
type MaybeCodeProductEvent = Extract<
  MaybeCodeEvent,
  | { type: "model.changed" }
  | { type: "permission-mode.changed" }
  | { type: "model.default.changed" }
  | { type: "mcp.resource.updated" }
  | { type: "mcp.resource.watch-closed" }
  | { type: "mcp.server.connected" }
  | { type: "mcp.interaction.requested" }
  | { type: "mcp.interaction.settled" }
  | { type: "mcp.server.catalog-updated" }
  | { type: "mcp.server.failed" }
  | { type: "mcp.server.disconnected" }
>;

/** @experimental */
export interface MaybeCodeController extends Omit<
  AgentWorkspaceController<MaybeCodeSessionEvent, MaybeCodeProductEvent, MaybeCodeCompactionSelection, MaybeCodeRun>,
  "forkSession"
> {
  /** Application of the active Session; a Session change replaces it. */
  readonly application: MaybeCodeApplication;
  /** Run a state change on the Session queue of the active application. */
  transition<T>(
    action: (application: MaybeCodeApplication) => T | Promise<T>,
    options?: AgentStateTransitionOptions,
  ): Promise<T>;
  steer?(
    options: import("@sortedyuan/may/session").SessionSteerOptions,
  ): Promise<import("@sortedyuan/may/session").SessionSteeringInput>;
  getForkPoints?(sessionId?: string): Promise<readonly UiForkPoint[]>;
  forkSession?(pointId: string, mode: "current" | "worktree"): Promise<string>;
  getWorkspaceGit?(): Promise<UiWorkspaceGit>;
  getCheckpoints?(sessionId?: string): Promise<readonly UiCheckpoint[]>;
  getWorktrees?(): Promise<readonly UiWorktree[]>;
  openWorktree?(id: string): Promise<void>;
  deleteWorktree?(id: string): Promise<void>;
  previewRestore?(runId: string, paths: readonly string[]): Promise<{ previewId: string; diff: UiWorkspaceDiff }>;
  restoreFiles?(previewId: string): Promise<void>;
  getChanges?(query: {
    readonly scope: "run" | "session" | "workspace";
    readonly runId?: string;
    readonly commit?: string;
  }): Promise<UiWorkspaceDiff>;
  readonly permissionMode: MaybeCodePermissionMode;
  readonly delegationNotifications?: boolean;
  setDelegationNotifications?(enabled: boolean): void;
  setPermissionMode(mode: MaybeCodePermissionMode): Promise<void>;
  startGoal?(objective: string, budget?: GoalBudget): Promise<GoalState>;
  resumeGoal?(): Promise<GoalState>;
  pauseGoal?(): Promise<GoalState>;
  cancelGoal?(): Promise<GoalState>;
  readSkill?(name: string): Promise<SkillDocument>;
  activateSkill?(name: string): Promise<SkillDocument>;
  submitSkill?(name: string, input: string): Promise<import("./events.js").MaybeCodeRun>;

  resolveDelegationRecovery?(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly detail: string },
  ): Promise<import("@sortedyuan/coordination/delegation/types").MaybeCodeDelegationRequest>;
  /** 对工作区 Session 以及它当前持有的子 Session 返回 true。 */
  ownsSession?(sessionId: string): boolean;

  getMcpStatus(): Promise<readonly McpServerStatus[]>;
  getMcpInteractions?(): ReturnType<McpInteractionBroker["list"]>;
  respondMcpInteraction?(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean;
  refreshMcp?(serverId?: string): Promise<void>;
  reconnectMcp?(serverId: string): Promise<void>;
  getMcpCatalog?: McpClientPool["catalog"];
  readMcpResource?: McpClientPool["readResource"];
  readMcpResourceTemplate?: McpClientPool["readResourceTemplate"];
  getMcpPrompt?: McpClientPool["getPrompt"];
  completeMcp?: McpClientPool["complete"];
  listMcpTasks?(): ReturnType<McpClientPool["listTasks"]>;
  getMcpTask?: McpClientPool["getTask"];
  updateMcpTask?: McpClientPool["updateTask"];
  waitMcpTask?: McpClientPool["waitTask"];
  cancelMcpTask?: McpClientPool["cancelTask"];
  forgetMcpTask?(serverId: string, id: string): Promise<void>;
  submitMcpTask?(serverId: string, id: string, instruction?: string): Promise<import("./events.js").MaybeCodeRun>;
  watchMcpResource?(serverId: string, uri: string): Promise<McpResourceSubscription>;
  unwatchMcpResource?(serverId: string, uri: string): Promise<void>;
  submitMcpResource?(serverId: string, uri: string, instruction?: string): Promise<import("./events.js").MaybeCodeRun>;
  submitMcpPrompt?(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
  ): Promise<import("./events.js").MaybeCodeRun>;
  listModels(): Promise<readonly MaybeCodeModelProfile[]>;
  getModelCapabilities?(
    profile?: string,
    refresh?: boolean,
  ): Promise<import("@sortedyuan/providers").ModelCapabilities>;
  readonly modelCapabilitiesAvailable?: boolean;
  getTelemetry?(
    query?: import("@sortedyuan/observability").DiagnosticQuery,
  ): import("@sortedyuan/observability").DiagnosticResult | undefined;
  switchModel(profile: string): Promise<MaybeCodeModelInfo>;
  /** Persist the profile used by future launches without switching models. */
  setDefaultModel(profile: string): Promise<void>;
  getReasoningEffort(): Promise<MaybeCodeReasoningEffortState>;
  /** Set an active-profile override, or clear it with undefined. */
  setReasoningEffort(effort?: string): Promise<MaybeCodeReasoningEffortState>;
}
