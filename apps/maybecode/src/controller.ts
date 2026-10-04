import type { AgentWorkspaceController } from "@may/application";
import type { GoalBudget, GoalState } from "@may/goal";
import type { ContextCompactionStrategy } from "@may/context";
import type { McpClientPool, McpServerStatus, McpResourceSubscription, McpInteractionBroker } from "@may/mcp";
import type { MaybeCodeEvent, MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";
import type { SkillDescriptor, SkillDiagnostic, SkillDocument } from "@may/skills";
import type { MaybeCodePermissionMode } from "./policy.js";
import type { UiForkPoint, UiWorkspaceGit, UiCheckpoint, UiWorktree, UiWorkspaceDiff } from "@may/ui-client";

export interface MaybeCodeSkillInfo extends SkillDescriptor { readonly active: boolean }

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

export type MaybeCodeAutoCompactionMode =
  | "prune-summary"
  | "history-reference"
  | "provider-native";

export type MaybeCodeCompactionStrategyName =
  | "prune-old-tool-results"
  | "summary-tail"
  | "history-reference"
  | "provider-native";

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

export interface MaybeCodeController extends Omit<AgentWorkspaceController<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection,
  MaybeCodeRun
>, "forkSession"> {
  steer?(options: import("@may/session").SessionSteerOptions): Promise<import("@may/session").SessionSteeringInput>;
  listSteeringInputs?(): readonly import("@may/session").SessionSteeringInput[];
  getForkPoints?(sessionId?: string): Promise<readonly UiForkPoint[]>;
  forkSession?(pointId: string, mode: "current" | "worktree"): Promise<string>;
  getWorkspaceGit?(): Promise<UiWorkspaceGit>;
  getCheckpoints?(sessionId?: string): Promise<readonly UiCheckpoint[]>;
  getWorktrees?(): Promise<readonly UiWorktree[]>;
  openWorktree?(id: string): Promise<void>;
  deleteWorktree?(id: string): Promise<void>;
  previewRestore?(runId: string, paths: readonly string[]): Promise<{ previewId: string; diff: UiWorkspaceDiff }>;
  restoreFiles?(previewId: string): Promise<void>;
  getChanges?(query: { readonly scope: "run" | "session" | "workspace"; readonly runId?: string; readonly commit?: string }): Promise<UiWorkspaceDiff>;
  readonly permissionMode: MaybeCodePermissionMode;
  setPermissionMode(mode: MaybeCodePermissionMode): Promise<void>;
  readonly instructions: MaybeCodeInstructions;
  readonly modelInfo: MaybeCodeModelInfo | undefined;
  getGoal?(): GoalState | undefined;
  startGoal?(objective: string, budget?: GoalBudget): Promise<GoalState>;
  resumeGoal?(): Promise<GoalState>;
  pauseGoal?(): Promise<GoalState>;
  cancelGoal?(): Promise<GoalState>;
  listSkills?(): readonly MaybeCodeSkillInfo[];
  getSkillDiagnostics?(): readonly SkillDiagnostic[];
  readSkill?(name: string): Promise<SkillDocument>;
  activateSkill?(name: string): Promise<SkillDocument>;
  submitSkill?(name: string, input: string): Promise<import("./events.js").MaybeCodeRun>;

  /** 普通请求的子 Agent 委派；关闭时返回空列表。 */
  listDelegationRequests?(): readonly import("./delegation.js").MaybeCodeDelegationRequest[];
  getDelegationState?(): import("./delegation.js").MaybeCodeDelegationState | undefined;
  delegationToolRecords?(taskId: string): Promise<import("./delegation.js").MaybeCodeDelegationToolRecords>;
  resolveDelegationRecovery?(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly detail: string },
  ): Promise<import("./delegation.js").MaybeCodeDelegationRequest>;
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
  submitMcpPrompt?(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<import("./events.js").MaybeCodeRun>;
  listModels(): Promise<readonly MaybeCodeModelProfile[]>;
  switchModel(profile: string): Promise<MaybeCodeModelInfo>;
  /** Persist the profile used by future launches without switching models. */
  setDefaultModel(profile: string): Promise<void>;
  getReasoningEffort(): Promise<MaybeCodeReasoningEffortState>;
  /** Set an active-profile override, or clear it with undefined. */
  setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState>;
}
