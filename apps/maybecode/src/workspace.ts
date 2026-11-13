import { randomUUID } from "node:crypto";
import { mediaHistory } from "./media-history.js";
import { MaybeCodeUsageError } from "./errors.js";
import { parsePermissionMode, type MaybeCodePermissionMode } from "./policy.js";

import type { AgentStateTransitionOptions } from "@sortedyuan/may";
import { observabilityService } from "@sortedyuan/observability/plugin";
import type { DiagnosticQuery, DiagnosticResult } from "@sortedyuan/observability";
import {
  GitCheckpointError,
  GitWorkspaceConflictError,
  ProjectGitWorkspace,
  type ProjectGitWorkspaceOptions,
  type GitRestorePreview,
} from "@sortedyuan/may/application/git-workspace";
import type { UiForkPoint, UiWorkspaceGit, UiCheckpoint, UiWorktree, UiWorkspaceDiff } from "@sortedyuan/ui-client";
import type { ContextBudget, ContextCompactionResult, ContextInspection } from "@sortedyuan/may/context";
import {
  AsyncEventQueue,
  RunCancelledError,
  isStreamingMayEvent,
  omitUndefined,
  type Model,
  type RunOptions,
} from "@sortedyuan/may/core";
import type {
  McpClientPool,
  McpServerStatus,
  McpOperationOptions,
  McpReadOptions,
  McpCompletionParams,
  McpResourceSubscription,
  McpInteractionBroker,
  McpTaskWaitOptions,
  McpTaskUpdateOptions,
} from "@sortedyuan/mcp";
import { GOAL_STATE_KEY } from "@sortedyuan/may/goals";
import type {
  ApprovalDecision,
  PersistentApprovalOptions,
  PermissionCheck,
  CreatePermissionRuleOptions,
} from "@sortedyuan/may/permissions";
import type { ModelCapabilities } from "@sortedyuan/providers";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionSteerOptions,
  SessionSubmitOptions,
} from "@sortedyuan/may/session";
import type { SessionCatalog, SessionSummary } from "@sortedyuan/may/session/catalog";

import type { MaybeCodeApplication } from "./application.js";
import type { MaybeCodeApplicationOptions } from "./application-open.js";
import type {
  MaybeCodeCompactionSelection,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type { MaybeCodeEvent, MaybeCodeRun } from "./events.js";
import type { MaybeCodeDelegationRequest } from "@sortedyuan/coordination/delegation/types";
import type { BaseWorkspace, WorkspaceState } from "./workspace-state.js";
import { openWorkspaceConfiguration } from "./workspace-configuration.js";
import { unknownReasoningEffort, withModelConfiguration } from "./model-transition.js";
import { workspaceForkPoints } from "./session-navigation.js";
import { MaybeCodeWorkspaceMcp } from "./workspace-mcp.js";

export interface MaybeCodeModelConfiguration {
  readonly model: Model;
  readonly modelInfo: MaybeCodeModelInfo;
  readonly contextBudget?: ContextBudget;
}

export interface MaybeCodeWorkspaceOptions extends Omit<MaybeCodeApplicationOptions, "sessionId" | "resume"> {
  readonly git?: false | Omit<ProjectGitWorkspaceOptions, "workspace">;
  readonly configureWorkspace?: (
    workspace: string,
  ) => Partial<MaybeCodeApplicationOptions> | Promise<Partial<MaybeCodeApplicationOptions>>;
  readonly permissionMode?: MaybeCodePermissionMode;
  readonly delegationNotifications?: boolean;
  readonly catalog: SessionCatalog;
  readonly sessionId?: string;
  /** Resume the latest workspace session when no sessionId is given. Defaults to false. */
  readonly autoResume?: boolean;
  readonly modelProfiles?: readonly MaybeCodeModelProfile[];
  readonly createModelConfiguration?: (
    profile: string,
    runtimeOptions?: Readonly<Record<string, unknown>>,
  ) => MaybeCodeModelConfiguration | Promise<MaybeCodeModelConfiguration>;
  readonly resolveModelCapabilities?: (
    profile: string,
    options?: { readonly refresh?: boolean },
  ) => Promise<ModelCapabilities>;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  /** Optional product-owned MCP status and lifecycle event source. */
  readonly mcp?: Pick<McpClientPool, "events" | "status"> &
    Partial<Omit<McpClientPool, "events" | "status" | "tools" | "close">>;
  /** Product-owned resources, such as tracing processors, closed after the workspace. */
  readonly closeOwnedResources?: () => void | Promise<void>;
}

/** MaybeCode model policy around the reusable multi-session workspace. */
export class MaybeCodeWorkspace implements MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;

  private readonly manager: BaseWorkspace;
  private readonly state: WorkspaceState;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeEvent>({
    maxBufferedValues: 1024,
    isDroppable: (event) =>
      event.type === "mcp.resource.updated" || (event.type === "run.event" && isStreamingMayEvent(event.event)),
  });
  private readonly managerEventRelay: Promise<void>;
  private readonly mcp = new MaybeCodeWorkspaceMcp({
    workspace: () => this.workspace,
    sessionId: () => this.sessionId,
    application: () => this.application,
    configuredMcp: () => this.state.options.mcp,
    closed: () => this.closed,
    isRunning: () => this.isRunning,
    throwIfClosed: () => this.throwIfClosed(),
    assertNoWorkspaceOperation: () => this.assertNoWorkspaceOperation(),
    ownsSession: (sessionId) => this.ownsSession(sessionId),
    transition: (action) => this.transition(action),
    submitPrepared: (...args) => this.manager.submitPrepared(...args),
    push: (event) => this.eventQueue.push(event),
    cancel: (reason) => this.cancel(reason),
  });
  private readonly modelOptionOverrides = new Map<string, Readonly<Record<string, unknown>>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pendingInputs = new Set<AbortController>();
  private inputEpoch = 0;
  private pendingSteering = 0;
  private readonly restorePreviews = new Map<
    string,
    { readonly sessionId: string; readonly preview: GitRestorePreview }
  >();
  private workspaceOperation: Promise<unknown> | undefined;
  private worktreeProcessId: string | undefined;

  private constructor(state: WorkspaceState, manager: BaseWorkspace) {
    this.state = state;
    this.manager = manager;
    this.events = this.eventQueue;
    this.managerEventRelay = this.relayEvents(manager.events);
    this.mcp.connectMcpEvents();
  }

  static async open(options: MaybeCodeWorkspaceOptions): Promise<MaybeCodeWorkspace> {
    const { state, manager } = await openWorkspaceConfiguration(options);
    const product = new MaybeCodeWorkspace(state, manager);
    await product.syncWorktreeProcess();
    return product;
  }

  get sessionId(): string {
    return this.manager.sessionId;
  }

  get workspace(): string {
    return this.manager.workspace;
  }

  /** Application of the active Session; a Session change replaces it. */
  get application(): MaybeCodeApplication {
    return this.manager.activeApplication;
  }

  /** Run a state change on the Session queue of the active application. */
  transition<T>(
    action: (application: MaybeCodeApplication) => T | Promise<T>,
    options?: AgentStateTransitionOptions,
  ): Promise<T> {
    return this.manager.runStateTransition(action, options);
  }

  private get git(): ProjectGitWorkspace | undefined {
    return this.state.git.get(this.workspace);
  }

  async getWorkspaceGit(): Promise<UiWorkspaceGit> {
    if (!this.git) return { path: this.workspace, status: "disabled", autoCommit: false };
    try {
      const status = await this.git.summary();
      return {
        path: this.workspace,
        status:
          status.state === "unborn" || (status.state === "unmanaged" && status.autoCommit && !status.readOnly)
            ? "initializing"
            : status.state === "unmanaged"
              ? "disabled"
              : "ready",
        autoCommit: status.autoCommit && !status.readOnly,
        detached: status.detached,
        ...(status.branch ? { branch: status.branch } : {}),
        ...(status.commit ? { commit: status.commit } : {}),
      };
    } catch (error) {
      return {
        path: this.workspace,
        status: "error",
        autoCommit: this.git.autoCommit,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getForkPoints(sessionId?: string): Promise<readonly UiForkPoint[]> {
    return workspaceForkPoints(
      this.manager,
      () => this.git,
      () => this.listSessions(),
      sessionId,
    );
  }

  async forkSession(pointId: string, mode: "current" | "worktree"): Promise<string> {
    return this.runWorkspaceOperation(() => this.forkWorkspaceSession(pointId, mode));
  }

  private async forkWorkspaceSession(pointId: string, mode: "current" | "worktree"): Promise<string> {
    const point = (await this.getForkPoints()).find((item) => item.id === pointId);
    if (!point?.available) throw new Error(point?.reason ?? "Session history position is unavailable");
    const positionSeq = Number(point.id.slice(point.sessionId.length + 1));
    const git = this.git;
    const checkpoint = await this.checkpointForRun(point.sessionId, point.runId);
    const sourceWorkspace = (await this.listSessions()).find((session) => session.id === point.sessionId)?.workspace;
    if (!sourceWorkspace) throw new Error("Source Session workspace is unavailable");
    let tree: Awaited<ReturnType<ProjectGitWorkspace["createWorktree"]>> | undefined;
    if (mode === "worktree") {
      if (!git || !checkpoint?.commit || !point.worktreeAvailable)
        throw new Error("Selected reply has no complete Git checkpoint");
      tree = await git.createWorktree({
        sessionId: point.sessionId,
        historyPosition: positionSeq,
        checkpointId: checkpoint.id,
      });
    }
    let sessionId: string;
    try {
      sessionId = await this.manager.forkSession(point.sessionId, positionSeq, {
        ...(tree ? { workspace: tree.workspace } : {}),
        metadata: {
          workspaceFork: {
            mode,
            sourceWorkspace,
            sourceCommit: point.commit ?? null,
            ...(tree ? { worktreeId: tree.id } : { currentFiles: true }),
          },
        },
      });
      if (tree) await git!.attachWorktreeSession(tree.id, sessionId);
      await this.syncWorktreeProcess();
    } catch (error) {
      if (tree) await git!.failWorktree(tree.id, error);
      throw error;
    }
    this.mcp.connectMcpEvents();
    return sessionId;
  }

  async getCheckpoints(sessionId = this.sessionId): Promise<readonly UiCheckpoint[]> {
    const points = await this.getForkPoints(sessionId);
    const checkpoints = (await this.git?.checkpoints()) ?? [];
    const sourceIds = [sessionId];
    while (true) {
      const created = (await this.manager.readSessionHistory(sourceIds[sourceIds.length - 1]!))[0];
      if (created?.type !== "session.created" || !created.fork) break;
      if (sourceIds.includes(created.fork.sessionId)) throw new Error("Session branch lineage contains a cycle");
      sourceIds.push(created.fork.sessionId);
      if (!(await this.listSessions()).some((session) => session.id === created.fork!.sessionId)) break;
    }
    return points.map((point) => {
      let checkpoint: import("@sortedyuan/may/application/git-workspace").GitCheckpoint | undefined;
      for (const sourceId of sourceIds) {
        checkpoint = [...checkpoints]
          .reverse()
          .find(
            (item) => item.sessionId === sourceId && (item.runId === point.runId || item.runIds?.includes(point.runId)),
          );
        if (checkpoint) break;
      }
      return {
        runId: point.runId,
        pointId: point.id,
        ...(checkpoint?.fromCommit ? { startCommit: checkpoint.fromCommit } : {}),
        ...(checkpoint?.commit ? { endCommit: checkpoint.commit } : {}),
        ...(checkpoint?.branch ? { branch: checkpoint.branch } : {}),
        status:
          checkpoint?.status === "failed"
            ? ("failed" as const)
            : !checkpoint || checkpoint.status === "uncommitted"
              ? ("unavailable" as const)
              : ("saved" as const),
        ...(checkpoint?.error ? { error: checkpoint.error } : {}),
      };
    });
  }

  private async checkpointForRun(
    sessionId: string,
    runId: string,
  ): Promise<import("@sortedyuan/may/application/git-workspace").GitCheckpoint | undefined> {
    if (!this.git) return undefined;
    const seen = new Set<string>();
    while (!seen.has(sessionId)) {
      seen.add(sessionId);
      const checkpoint = await this.git.checkpointByRun(sessionId, runId);
      if (checkpoint) return checkpoint;
      const created = (await this.manager.readSessionHistory(sessionId))[0];
      if (created?.type !== "session.created" || !created.fork) return undefined;
      sessionId = created.fork.sessionId;
    }
    throw new Error("Session branch lineage contains a cycle");
  }

  async getWorktrees(): Promise<readonly UiWorktree[]> {
    return ((await this.git?.listWorktrees()) ?? [])
      .filter((tree) => tree.status !== "deleted")
      .map((tree) => ({
        id: tree.id,
        path: tree.workspace,
        branch: tree.branch,
        sourceSessionId: tree.sourceSessionId,
        pointId: `${tree.sourceSessionId}:${tree.historyPosition}`,
        commit: tree.commit,
        sessionIds: tree.sessions,
        status: tree.status === "failed" ? "error" : tree.status === "creating" ? "creating" : "ready",
        ...(tree.error ? { error: tree.error } : {}),
      }));
  }

  async openWorktree(id: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.openWorkspaceWorktree(id));
  }

  private async openWorkspaceWorktree(id: string): Promise<void> {
    const tree = (await this.getWorktrees()).find((item) => item.id === id);
    if (!tree || tree.status !== "ready") throw new Error("Managed worktree is unavailable");
    const session = (await this.listSessions()).find((item) => tree.sessionIds.includes(item.id));
    if (!session) throw new Error("Worktree has no available Session");
    await this.resumeWorkspaceSession(session.id);
  }

  async deleteWorktree(id: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.deleteWorkspaceWorktree(id));
  }

  private async deleteWorkspaceWorktree(id: string): Promise<void> {
    const git = this.requireGit();
    const tree = (await git.listWorktrees()).find((item) => item.id === id);
    if (!tree) throw new Error("Managed worktree is unavailable");
    if (tree.workspace === this.workspace) throw new Error("Switch to another workspace before deleting this worktree");
    for (const sessionId of tree.sessions) {
      if ((await this.listSessions()).some((session) => session.id === sessionId))
        throw new Error("Delete or move associated Sessions before deleting this worktree");
      await git.attachWorktreeSession(id, sessionId, false);
    }
    await git.deleteWorktree(id);
  }

  async getChanges(query: {
    readonly scope: "run" | "session" | "workspace";
    readonly runId?: string;
    readonly commit?: string;
  }): Promise<UiWorkspaceDiff> {
    const git = this.requireGit();
    const checkpoints = await git.checkpoints(this.sessionId);
    let from: string | undefined;
    let to: string | undefined;
    if (query.scope === "run") {
      if (!query.runId) throw new Error("Run changes require a runId");
      const checkpoint = await this.checkpointForRun(this.sessionId, query.runId);
      from = checkpoint?.fromCommit;
      to = checkpoint?.status === "uncommitted" || checkpoint?.status === "failed" ? undefined : checkpoint?.commit;
    } else if (query.scope === "session") {
      const last = checkpoints[checkpoints.length - 1];
      from = checkpoints[0]?.commit;
      to = last?.status === "uncommitted" || last?.status === "failed" ? undefined : last?.commit;
    } else from = query.commit ?? (await git.status()).commit;
    if (!from) throw new Error("Git comparison has no available initial version");
    const diff = await git.diff({ from, ...(to ? { to } : {}) });
    const files = diff.files.map((file) => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status === "typechanged" || file.status === "unknown" ? ("modified" as const) : file.status,
      binary: file.binary,
      additions: file.insertions,
      deletions: file.deletions,
      patch: file.patch,
    }));
    return {
      scope: query.scope,
      title:
        query.scope === "run" ? "本轮文件变化" : query.scope === "session" ? "Session 文件变化" : "当前工作区文件变化",
      from: diff.from,
      ...(diff.to ? { to: diff.to } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      uncommitted: !diff.to,
      files,
    };
  }

  async previewRestore(runId: string, paths: readonly string[]): Promise<{ previewId: string; diff: UiWorkspaceDiff }> {
    return this.runWorkspaceOperation(() => this.previewWorkspaceRestore(runId, paths));
  }

  private async previewWorkspaceRestore(
    runId: string,
    paths: readonly string[],
  ): Promise<{ previewId: string; diff: UiWorkspaceDiff }> {
    const git = this.requireGit();
    if (git.readOnly) throw new Error("File restoration is disabled in a read-only workspace");
    const checkpoint = await this.checkpointForRun(this.sessionId, runId);
    if (!checkpoint) throw new Error("Run has no Git checkpoint");
    const preview = await git.previewRestore({ checkpointId: checkpoint.id, paths });
    const previewId = randomUUID();
    this.restorePreviews.clear();
    this.restorePreviews.set(previewId, { sessionId: this.sessionId, preview });
    return {
      previewId,
      diff: {
        scope: "run",
        runId,
        title: "文件恢复预览",
        to: preview.commit,
        uncommitted: true,
        restorePreviewId: previewId,
        files: preview.files.map((file) => ({
          path: file.path,
          status:
            file.targetMode === undefined ? "deleted" : file.beforeFingerprint === undefined ? "added" : "modified",
          binary: file.binary,
          additions: 0,
          deletions: 0,
          patch: file.patch,
        })),
      },
    };
  }

  async restoreFiles(previewId: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.transition(() => this.restoreWorkspaceFiles(previewId)));
  }

  private async restoreWorkspaceFiles(previewId: string): Promise<void> {
    const saved = this.restorePreviews.get(previewId);
    if (!saved || saved.sessionId !== this.sessionId || saved.preview.workspace !== this.workspace)
      throw new Error("File restore preview is no longer available");
    try {
      const checkpoint = await this.requireGit().restore(saved.preview, {
        sessionId: this.sessionId,
        commitMessage: "Restore selected files from a session checkpoint",
      });
      this.restorePreviews.delete(previewId);
      this.eventQueue.push({ type: "workspace.git.changed", checkpoint });
    } catch (error) {
      if (error instanceof GitCheckpointError)
        this.eventQueue.push({ type: "workspace.git.changed", checkpoint: error.checkpoint });
      throw error;
    }
  }

  private requireGit(): ProjectGitWorkspace {
    if (!this.git) throw new Error("Git workspace management is disabled");
    return this.git;
  }

  private assertWorkspaceIdle(): void {
    this.throwIfClosed();
    if (this.isRunning || this.application.getGoal()?.status === "active" || this.getMcpInteractions().length)
      throw new Error("Finish the active operation before changing the workspace");
  }

  private assertNoWorkspaceOperation(): void {
    this.throwIfClosed();
    if (this.workspaceOperation)
      throw new GitWorkspaceConflictError("Finish the active workspace operation before changing Session state");
  }

  private runWorkspaceOperation<T>(work: () => Promise<T>, requireIdle = true): Promise<T> {
    if (requireIdle) this.assertWorkspaceIdle();
    else this.assertNoWorkspaceOperation();
    if (this.application.getGoal()?.status === "active")
      throw new GitWorkspaceConflictError("Pause or finish the active Goal before changing the workspace");
    const previousSessionId = this.sessionId;
    const previousOptions = this.state.options;
    const operation = Promise.resolve()
      .then(work)
      .catch((error) => {
        if (this.sessionId === previousSessionId) this.state.options = previousOptions;
        throw error;
      });
    this.workspaceOperation = operation;
    return operation.finally(() => {
      if (this.workspaceOperation === operation) this.workspaceOperation = undefined;
    });
  }

  private async syncWorktreeProcess(): Promise<void> {
    const git = this.state.git.get(this.state.rootWorkspace);
    if (!git || git.readOnly) return;
    const tree = (await git.listWorktrees()).find(
      (item) => item.workspace === this.workspace && item.status === "ready",
    );
    if (this.worktreeProcessId && this.worktreeProcessId !== tree?.id)
      await git.trackWorktreeProcess(this.worktreeProcessId, process.pid, false);
    this.worktreeProcessId = tree?.id;
    if (tree) {
      await git.attachWorktreeSession(tree.id, this.sessionId);
      await git.trackWorktreeProcess(tree.id, process.pid);
    }
  }

  get permissionMode(): MaybeCodePermissionMode {
    return this.state.options.permissionMode ?? "default";
  }

  get delegationNotifications(): boolean {
    return this.state.options.delegationNotifications ?? false;
  }

  setDelegationNotifications(enabled: boolean): void {
    this.throwIfClosed();
    if (typeof enabled !== "boolean") throw new TypeError("delegationNotifications must be boolean");
    this.state.options = { ...this.state.options, delegationNotifications: enabled };
  }

  async setPermissionMode(mode: MaybeCodePermissionMode): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    parsePermissionMode(mode);
    await this.transition(
      () => {
        if (mode === this.permissionMode) return;
        if (this.isRunning || this.application.getGoal()?.status === "active" || this.getMcpInteractions().length > 0) {
          throw new Error("Pause or cancel the current operation before changing permission mode");
        }
        this.state.options = { ...this.state.options, permissionMode: mode };
        this.eventQueue.push({ type: "permission-mode.changed", mode });
      },
      { activeOperationMessage: "Pause or cancel the current operation before changing permission mode" },
    );
  }

  get isRunning(): boolean {
    return (
      this.workspaceOperation !== undefined ||
      this.manager.isRunning ||
      this.mcp.busy ||
      this.pendingInputs.size > 0 ||
      this.pendingSteering > 0
    );
  }

  readSkill(name: string) {
    this.assertNoWorkspaceOperation();
    return this.transition(
      async ({ agent }) => {
        if (!agent.skills) throw new Error("Skills are disabled");
        return agent.skills.listActive().find((item) => item.name === name) ?? agent.skills.registry.load(name);
      },
      { requireIdle: false },
    );
  }

  activateSkill(name: string) {
    this.assertNoWorkspaceOperation();
    return this.transition((app) => app.activateSkill(name));
  }

  submitSkill(name: string, input: string): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    return this.manager.submitPrepared(async () => {
      await this.application.activateSkill(name);
      return { input: `Use the ${name} skill for this task:\n${input}` };
    });
  }

  getMcpStatus(): Promise<readonly McpServerStatus[]> {
    return this.mcp.getMcpStatus();
  }

  getMcpInteractions() {
    return this.mcp.getMcpInteractions();
  }

  respondMcpInteraction(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean {
    return this.mcp.respondMcpInteraction(id, response);
  }

  ownsSession(sessionId: string): boolean {
    return sessionId === this.sessionId || this.application.ownsSession(sessionId);
  }

  refreshMcp(serverId?: string): Promise<void> {
    return this.mcp.refreshMcp(serverId);
  }

  reconnectMcp(serverId: string): Promise<void> {
    return this.mcp.reconnectMcp(serverId);
  }

  getMcpCatalog() {
    return this.mcp.getMcpCatalog();
  }

  listMcpTasks() {
    return this.mcp.listMcpTasks();
  }
  getMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcp.getMcpTask(serverId, id, options);
  }
  updateMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) {
    return this.mcp.updateMcpTask(serverId, id, options);
  }
  waitMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) {
    return this.mcp.waitMcpTask(serverId, id, options);
  }
  cancelMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcp.cancelMcpTask(serverId, id, options);
  }
  forgetMcpTask(serverId: string, id: string) {
    return this.mcp.forgetMcpTask(serverId, id);
  }
  submitMcpTask(serverId: string, id: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcp.submitMcpTask(serverId, id, instruction);
  }

  readMcpResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.mcp.readMcpResource(serverId, uri, options);
  }

  readMcpResourceTemplate(
    serverId: string,
    template: string,
    variables: Readonly<Record<string, string | string[]>>,
    options: McpReadOptions = {},
  ) {
    return this.mcp.readMcpResourceTemplate(serverId, template, variables, options);
  }

  getMcpPrompt(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    options: McpOperationOptions = {},
  ) {
    return this.mcp.getMcpPrompt(serverId, name, args, options);
  }

  completeMcp(serverId: string, params: McpCompletionParams, options: McpOperationOptions = {}) {
    return this.mcp.completeMcp(serverId, params, options);
  }

  submitMcpResource(serverId: string, uri: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcp.submitMcpResource(serverId, uri, instruction);
  }

  submitMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<MaybeCodeRun> {
    return this.mcp.submitMcpPrompt(serverId, name, args);
  }

  watchMcpResource(serverId: string, uri: string): Promise<McpResourceSubscription> {
    return this.mcp.watchMcpResource(serverId, uri);
  }

  unwatchMcpResource(serverId: string, uri: string): Promise<void> {
    return this.mcp.unwatchMcpResource(serverId, uri);
  }

  async submit(options: SessionSubmitOptions): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    const controller = new AbortController();
    this.pendingInputs.add(controller);
    try {
      return await this.manager.submit({
        ...options,
        signal: options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
      });
    } finally {
      this.pendingInputs.delete(controller);
    }
  }

  async steer(options: SessionSteerOptions) {
    this.assertNoWorkspaceOperation();
    const epoch = this.inputEpoch;
    this.pendingSteering++;
    try {
      return await this.transition(
        (app) => {
          if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before acceptance");
          return app.steer(options);
        },
        { requireIdle: false },
      );
    } finally {
      this.pendingSteering--;
    }
  }

  startGoal(objective: string, budget?: import("@sortedyuan/may/goals").GoalBudget) {
    this.assertNoWorkspaceOperation();
    return this.transition((app) => app.startGoal(objective, budget));
  }
  resumeGoal() {
    this.assertNoWorkspaceOperation();
    return this.transition((app) => app.resumeGoal());
  }
  pauseGoal() {
    return this.transition((app) => app.pauseGoal(), { requireIdle: false });
  }
  cancelGoal() {
    return this.transition((app) => app.cancelGoal(), { requireIdle: false });
  }

  retry(): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    return this.manager.retry();
  }

  cancel(reason?: string): boolean {
    this.inputEpoch++;
    const pending = this.pendingInputs.size > 0 || this.pendingSteering > 0 || this.mcp.busy;
    for (const controller of this.pendingInputs)
      controller.abort(new RunCancelledError(reason ?? "Input cancelled before execution"));
    this.mcp.abortOperation(reason);
    return this.manager.cancel(reason) || pending;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: PersistentApprovalOptions,
  ): Promise<boolean> {
    return this.manager.resolveApproval(requestId, decision, options);
  }

  listPermissionRules(scopeId?: string) {
    return this.manager.listPermissionRules(scopeId);
  }
  createPermissionRule(check: PermissionCheck, options: CreatePermissionRuleOptions) {
    return this.manager.createPermissionRule(check, options);
  }
  createPermissionRuleFrom(id: string, options: CreatePermissionRuleOptions) {
    return this.transition((app) => app.createPermissionRuleFrom(id, options));
  }
  revokePermissionRule(id: string) {
    return this.manager.revokePermissionRule(id);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.manager.listSessions();
  }

  async readSessionHistory(sessionId: string) {
    return mediaHistory(await this.manager.readSessionHistory(sessionId));
  }

  async newSession(): Promise<string> {
    return this.runWorkspaceOperation(() => this.newWorkspaceSession(), false);
  }

  private async newWorkspaceSession(): Promise<string> {
    const sessionId = await this.manager.newSession();
    await this.syncWorktreeProcess();
    this.mcp.connectMcpEvents();
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.resumeWorkspaceSession(sessionId), false);
  }

  private async resumeWorkspaceSession(sessionId: string): Promise<void> {
    await this.manager.resumeSession(sessionId);
    await this.syncWorktreeProcess();
    this.mcp.connectMcpEvents();
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    this.assertNoWorkspaceOperation();
    return this.manager.renameSession(sessionId, title);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.runWorkspaceOperation(() => this.deleteWorkspaceSession(sessionId));
  }

  private async deleteWorkspaceSession(sessionId: string): Promise<boolean> {
    const deleted = await this.manager.deleteSession(sessionId);
    if (deleted && this.git)
      for (const tree of await this.git.listWorktrees()) {
        if (tree.sessions.includes(sessionId)) await this.git.attachWorktreeSession(tree.id, sessionId, false);
      }
    return deleted;
  }

  async listModels(): Promise<readonly MaybeCodeModelProfile[]> {
    this.throwIfClosed();
    return [...(this.state.options.modelProfiles ?? [])];
  }

  async switchModel(profile: string): Promise<MaybeCodeModelInfo> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    const selected = (this.state.options.modelProfiles ?? []).find((candidate) => candidate.name === profile);
    if (selected === undefined) throw new Error(`Unknown model profile "${profile}"`);

    const result = await this.transition(
      async (current) => {
        if (current.modelInfo?.profile === profile && !current.modelUpdateFailed) {
          this.manager.emit({ type: "model.changed", model: current.modelInfo });
          return current.modelInfo;
        }
        this.assertModelChangeAllowed();
        const create = this.state.options.createModelConfiguration;
        if (create === undefined) {
          throw new Error("The active MaybeCode workspace cannot switch models");
        }
        const configuration = await create(profile, this.modelOptionOverrides.get(profile));
        if (configuration.modelInfo.profile !== profile) {
          throw new Error(
            `Model configuration for "${profile}" returned profile ` +
              `"${configuration.modelInfo.profile ?? "unknown"}"`,
          );
        }
        const nextOptions = withModelConfiguration(
          this.state.options,
          configuration,
          this.modelOptionOverrides.get(profile),
        );
        this.assertModelChangeAllowed();
        await current.updateModel({
          ...configuration,
          ...omitUndefined({ modelRuntimeOptions: nextOptions.modelRuntimeOptions }),
        });
        this.state.options = nextOptions;
        this.manager.emit({ type: "model.changed", model: current.modelInfo! });
        return current.modelInfo!;
      },
      {
        activeOperationMessage: "Cannot switch models while an operation is active",
      },
    );
    this.mcp.connectMcpEvents();
    return result;
  }

  private assertModelChangeAllowed(): void {
    if (this.mcp.busy || this.getMcpInteractions().length > 0) {
      throw new Error("Finish the MCP operation before changing the model");
    }
  }

  setDefaultModel(profile: string): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    return this.transition(
      async () => {
        const profiles = this.state.options.modelProfiles ?? [];
        if (!profiles.some((candidate) => candidate.name === profile)) {
          throw new Error(`Unknown model profile "${profile}"`);
        }
        const persist = this.state.options.persistDefaultModel;
        if (persist === undefined) {
          throw new Error("The active MaybeCode configuration is not writable");
        }

        await persist(profile);
        this.state.options = {
          ...this.state.options,
          modelProfiles: profiles.map((candidate) => ({
            ...candidate,
            isDefault: candidate.name === profile,
          })),
        };
        this.manager.emit({ type: "model.default.changed", profile });
      },
      { requireIdle: false },
    );
  }

  async getReasoningEffort(): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    const profile = this.application.modelInfo?.profile;
    if (profile === undefined) return unknownReasoningEffort();
    const resolveCapabilities = this.state.options.resolveModelCapabilities;
    if (resolveCapabilities === undefined) return unknownReasoningEffort();

    const capabilities = (await resolveCapabilities(profile)).reasoningEffort;
    const configured = (this.state.options.modelProfiles ?? []).find(
      (candidate) => candidate.name === profile,
    )?.reasoningEffort;
    const requested = this.modelOptionOverrides.get(profile)?.reasoningEffort;
    const restored = this.state.options.modelRuntimeOptions?.reasoningEffort;
    const override = typeof restored === "string" ? restored : requested;
    const overridden = typeof override === "string" && (override !== configured || requested === override);
    const effectiveEffort =
      typeof override === "string"
        ? override
        : (configured ?? (capabilities.status === "known" ? capabilities.defaultEffort : undefined));
    return {
      status: capabilities.status,
      source: capabilities.source,
      efforts: capabilities.status === "known" ? [...capabilities.efforts] : [],
      ...omitUndefined({
        defaultEffort: capabilities.status === "known" ? capabilities.defaultEffort : undefined,
        effectiveEffort,
      }),
      overridden,
    };
  }

  async getModelCapabilities(
    profile = this.application.modelInfo?.profile,
    refresh = false,
  ): Promise<ModelCapabilities> {
    if (profile === undefined || this.state.options.resolveModelCapabilities === undefined) {
      throw new Error("The active workspace does not provide model capability discovery");
    }
    if (!(this.state.options.modelProfiles ?? []).some((model) => model.name === profile)) {
      throw new Error(`Unknown model profile: ${profile}`);
    }
    return this.state.options.resolveModelCapabilities(profile, { refresh });
  }

  get modelCapabilitiesAvailable(): boolean {
    return (
      this.application.modelInfo?.profile !== undefined && this.state.options.resolveModelCapabilities !== undefined
    );
  }

  getTelemetry(query: DiagnosticQuery = {}): DiagnosticResult | undefined {
    const sessionId = query.sessionId ?? this.sessionId;
    if (!this.ownsSession(sessionId)) throw new Error("Telemetry session does not belong to this workspace");
    return this.application.agent
      .getOptionalService(observabilityService)
      ?.diagnostics?.getDiagnostics({ ...query, sessionId });
  }

  async setReasoningEffort(effort?: string): Promise<MaybeCodeReasoningEffortState> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    await this.transition(async (current) => {
      this.assertModelChangeAllowed();
      const profile = current.modelInfo?.profile;
      if (profile === undefined) {
        throw new Error("The active model has no configurable profile");
      }
      const state = await this.getReasoningEffort();
      if (effort !== undefined) {
        if (state.status === "unknown") {
          throw new Error(`Reasoning effort capabilities are unknown for model profile "${profile}"`);
        }
        if (state.status === "unsupported") {
          throw new Error(`Model profile "${profile}" does not support effort-based reasoning`);
        }
        if (!state.efforts.includes(effort)) {
          throw new Error(
            `Reasoning effort "${effort}" is unsupported by model profile ` +
              `"${profile}"; supported values: ${state.efforts.join(", ")}`,
          );
        }
      }

      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot tune models");
      }
      const configuration = await create(profile, effort === undefined ? undefined : { reasoningEffort: effort });
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
        effort === undefined ? undefined : { reasoningEffort: effort },
      );
      this.assertModelChangeAllowed();
      await current.updateModel({
        ...configuration,
        ...omitUndefined({ modelRuntimeOptions: nextOptions.modelRuntimeOptions }),
      });
      this.state.options = nextOptions;
      if (effort === undefined) this.modelOptionOverrides.delete(profile);
      else this.modelOptionOverrides.set(profile, { reasoningEffort: effort });
      this.manager.emit({ type: "model.changed", model: current.modelInfo! });
    });
    this.mcp.connectMcpEvents();
    return this.getReasoningEffort();
  }

  async history() {
    return mediaHistory(await this.manager.history());
  }

  listRecoveries() {
    return this.manager.listRecoveries();
  }
  resolveRecovery(id: string, finding: string) {
    this.assertNoWorkspaceOperation();
    return this.manager.resolveRecovery(id, finding);
  }

  resolveDelegationRecovery(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly detail: string },
  ): Promise<MaybeCodeDelegationRequest> {
    this.assertNoWorkspaceOperation();
    return this.application.resolveDelegationRecovery(requestId, taskId, finding, outcome);
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.manager.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.manager.inspectContext();
  }

  compactContext(strategy?: MaybeCodeCompactionSelection): Promise<ContextCompactionResult> {
    this.assertNoWorkspaceOperation();
    return this.manager.compactContext(strategy);
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const watchesClosing = this.mcp.closeWatches("MaybeCode workspace is closing");
    if (this.workspaceOperation) await Promise.allSettled([this.workspaceOperation]);
    const failures: unknown[] = [];
    try {
      await this.manager.close();
      await this.removeEmptySessions();
    } catch (error) {
      failures.push(error);
    }
    if (this.worktreeProcessId) {
      try {
        await this.state.git
          .get(this.state.rootWorkspace)!
          .trackWorktreeProcess(this.worktreeProcessId, process.pid, false);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.state.options.closeOwnedResources?.();
    } catch (error) {
      failures.push(error);
    }
    failures.push(...(await watchesClosing).flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    try {
      await this.mcp.disconnectMcpEvents();
      await Promise.all([this.managerEventRelay, ...this.mcp.mcpEventRelays]);
    } catch (error) {
      failures.push(error);
    } finally {
      this.eventQueue.close();
    }
    failures.push(...this.mcp.mcpRelayErrors);
    if (failures.length > 0) {
      throw new AggregateError(failures, "MaybeCode workspace failed to close");
    }
  }

  private async removeEmptySessions(): Promise<void> {
    const { store, catalog } = this.state.options;
    for (const [sessionId, workspace] of this.state.createdSessions) {
      const history = await store.read(sessionId);
      if (
        history.some(
          (event) =>
            event.type === "input.submitted" ||
            event.type === "input.steering.queued" ||
            event.type === "run.started" ||
            event.type === "assistant.completed" ||
            (event.type === "session.created" && event.fork !== undefined) ||
            (event.type === "state.updated" && event.key === GOAL_STATE_KEY),
        )
      )
        continue;
      if (!store.delete || !catalog.remove)
        throw new Error("Empty Session cleanup requires store and catalog deletion support");
      await store.delete(sessionId);
      await catalog.remove(sessionId, workspace);
    }
  }

  private async relayEvents(events: AsyncIterable<MaybeCodeEvent>): Promise<void> {
    for await (const event of events) {
      if (event.type === "session.changed" || event.type === "model.changed") this.mcp.connectMcpEvents();
      if (
        event.type === "mcp.interaction.requested" &&
        (event.request.owner.workspaceId !== this.workspace || !this.ownsSession(event.request.owner.sessionId))
      )
        continue;
      this.eventQueue.push(event);
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
}
