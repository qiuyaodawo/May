import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mediaHistory } from "./media-history.js";
import { MaybeCodeUsageError } from "./errors.js";
import { createCodingPermissionPolicy, parsePermissionMode, type MaybeCodePermissionMode } from "./policy.js";

import { AgentWorkspace } from "@may/application";
import { GitCheckpointError, GitWorkspaceConflictError, ProjectGitWorkspace, type ProjectGitWorkspaceOptions, type GitRestorePreview } from "@may/application/git-workspace";
import type { UiForkPoint, UiWorkspaceGit, UiCheckpoint, UiWorktree, UiWorkspaceDiff } from "@may/ui-client";
import type {
  ContextBudget,
  ContextCompactionResult,
  ContextInspection,
} from "@may/context";
import {
  AsyncEventQueue,
  RunCancelledError,
  isStreamingMayEvent,
  type Model,
  type RunOptions,
} from "@may/core";
import { mcpResourceToUserMessage, mcpPromptToUserMessage, mcpTaskToUserMessage, type McpClientPool, type McpServerStatus,
  type McpOperationOptions, type McpReadOptions, type McpCompletionParams, type McpResourceSubscription,
  type McpInteractionBroker, type McpTaskWaitOptions, type McpTaskUpdateOptions,
} from "@may/mcp";
import type { ApprovalDecision } from "@may/permissions";
import type { ModelCapabilities } from "@may/providers";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionSteerOptions,
  SessionSubmitOptions,
} from "@may/session";
import type { SessionCatalog, SessionSummary } from "@may/session/catalog";

import {
  MaybeCodeApplication,
  type MaybeCodeApplicationOptions,
} from "./application.js";
import type {
  MaybeCodeCompactionSelection,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type {
  MaybeCodeEvent,
  MaybeCodeRun,
  MaybeCodeSessionEvent,
} from "./events.js";
import type {
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationToolRecords,
} from "./delegation.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export interface MaybeCodeModelConfiguration {
  readonly model: Model;
  readonly modelInfo: MaybeCodeModelInfo;
  readonly contextBudget?: ContextBudget;
}

export interface MaybeCodeWorkspaceOptions extends Omit<
  MaybeCodeApplicationOptions,
  "sessionId" | "resume"
> {
  readonly git?: false | Omit<ProjectGitWorkspaceOptions, "workspace">;
  readonly configureWorkspace?: (workspace: string) => Partial<MaybeCodeApplicationOptions> | Promise<Partial<MaybeCodeApplicationOptions>>;
  readonly permissionMode?: MaybeCodePermissionMode;
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
  ) => Promise<ModelCapabilities>;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  /** Optional product-owned MCP status and lifecycle event source. */
  readonly mcp?: Pick<McpClientPool, "events" | "status"> & Partial<Omit<McpClientPool, "events" | "status" | "tools" | "close">>;
  /** Product-owned resources, such as tracing processors, closed after the workspace. */
  readonly closeOwnedResources?: () => void | Promise<void>;
}

type MaybeCodeProductEvent = Exclude<MaybeCodeEvent, MaybeCodeSessionEvent | {
  type: "session.changed";
  sessionId: string;
  resumed: boolean;
}>;

type ActiveWorkspaceOptions = Omit<
  MaybeCodeWorkspaceOptions,
  "sessionId" | "autoResume"
>;

interface WorkspaceState {
  options: ActiveWorkspaceOptions;
  readonly rootWorkspace: string;
  readonly git: Map<string, ProjectGitWorkspace>;
}

type BaseWorkspace = AgentWorkspace<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection,
  MaybeCodeRun,
  MaybeCodeApplication
>;

/** MaybeCode model policy around the reusable multi-session workspace. */
export class MaybeCodeWorkspace implements MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;

  private readonly manager: BaseWorkspace;
  private readonly state: WorkspaceState;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeEvent>({
    maxBufferedValues: 1024,
    isDroppable: (event) =>
      event.type === "mcp.resource.updated" || event.type === "run.event" && isStreamingMayEvent(event.event),
  });
  private readonly managerEventRelay: Promise<void>;
  private readonly mcpEventRelays = new Set<Promise<void>>();
  private readonly mcpEventIterators = new Set<AsyncIterator<MaybeCodeEvent>>();
  private readonly mcpRelayErrors: unknown[] = [];
  private observedMcp: MaybeCodeWorkspaceOptions["mcp"];
  private readonly modelOptionOverrides = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly mcpLifetime = new AbortController();
  private mcpOperationController: AbortController | undefined;
  private readonly mcpWatches = new Map<string, McpResourceSubscription>();
  private readonly pendingInputs = new Set<AbortController>();
  private inputEpoch = 0;
  private pendingSteering = 0;
  private readonly restorePreviews = new Map<string, { readonly sessionId: string; readonly preview: GitRestorePreview }>();
  private workspaceOperation: Promise<unknown> | undefined;
  private worktreeProcessId: string | undefined;

  private constructor(state: WorkspaceState, manager: BaseWorkspace) {
    this.state = state;
    this.manager = manager;
    this.events = this.eventQueue;
    this.managerEventRelay = this.relayEvents(manager.events);
    this.connectMcpEvents();
  }

  static async open(
    options: MaybeCodeWorkspaceOptions,
  ): Promise<MaybeCodeWorkspace> {
    const state: WorkspaceState = {
      rootWorkspace: resolve(options.workspace),
      git: new Map(),
      options: withoutSelection({
        ...options,
        permissionMode: parsePermissionMode(options.permissionMode ?? "default"),
        workspace: resolve(options.workspace),
      }),
    };
    const permissionPolicy = createCodingPermissionPolicy({
      mode: () => state.options.permissionMode ?? "default",
      ...(options.permissionPolicy === undefined ? {} : { policy: options.permissionPolicy }),
    });
    state.options = { ...state.options, permissionPolicy: check => {
      if (state.options.git && state.options.git.readOnly && !["read", "skill_read", "session_history", "session_history_search", "session_history_read", "get_context_remaining", "context_notes", "new_context", "get_goal"].includes(check.tool.name)) return "deny";
      return permissionPolicy(check);
    } };
    if (state.options.git !== false) state.git.set(state.rootWorkspace, await ProjectGitWorkspace.open({
      ...state.options.git, workspace: state.rootWorkspace,
      excludedPaths: [...(state.options.git?.excludedPaths ?? []), ...workspaceStoragePaths(state.options, state.rootWorkspace)],
    }));
    const manager = await AgentWorkspace.open<
      MaybeCodeSessionEvent,
      MaybeCodeProductEvent,
      MaybeCodeCompactionSelection,
      MaybeCodeRun,
      MaybeCodeApplication
    >({
      workspace: state.options.workspace,
      store: state.options.store,
      catalog: state.options.catalog,
      workspacePaths: async () => [state.rootWorkspace, ...((await state.git.get(state.rootWorkspace)?.listWorktrees()) ?? [])
        .filter(tree => tree.status !== "deleted").map(tree => tree.workspace)],
      openApplication: async (selection) => {
        const workspace = selection.workspace ?? state.options.workspace;
        if (workspace !== state.options.workspace && (state.options.tools || state.options.additionalTools || state.options.toolSource) && !state.options.configureWorkspace) {
          throw new Error("Custom workspace tools require configureWorkspace before creating or opening a worktree");
        }
        const configured = await state.options.configureWorkspace?.(workspace);
        let gitWorkspace = state.git.get(workspace);
        if (state.options.git !== false && !gitWorkspace) {
          gitWorkspace = await ProjectGitWorkspace.open({ ...state.options.git, workspace,
            excludedPaths: [...(state.options.git?.excludedPaths ?? []), ...workspaceStoragePaths(state.options, workspace)] });
          state.git.set(workspace, gitWorkspace);
        }
        let nextOptions: ActiveWorkspaceOptions = { ...state.options, ...configured, workspace,
          modelRuntimeOptions: state.options.modelRuntimeOptions ?? configuredModelOptions(state.options, state.options.modelInfo?.profile) };
        if (selection.fork) {
          if (!state.options.store.inspect) throw new Error("Historical model selection requires read-only Session inspection");
          const history = await state.options.store.inspect(selection.fork.sessionId);
          const event = [...history].reverse().find(item => item.seq <= selection.fork!.positionSeq && item.type === "state.updated" && item.key === "maybecode.model");
          if (event?.type === "state.updated") {
            const saved = readHistoricalModel(event.value);
            if (saved.profile && nextOptions.createModelConfiguration) {
              const configuration = await nextOptions.createModelConfiguration(saved.profile, saved.runtimeOptions);
              assertHistoricalModel(saved, configuration.modelInfo);
              nextOptions = withModelConfiguration(nextOptions, configuration, saved.runtimeOptions);
            } else {
              assertHistoricalModel(saved, nextOptions.modelInfo);
              nextOptions = { ...nextOptions, modelRuntimeOptions: saved.runtimeOptions };
            }
          }
        }
        const app = await MaybeCodeApplication.open({ ...applicationOptions(nextOptions),
          ...(gitWorkspace ? { gitWorkspace } : {}),
          ...(selection.fork ? { fork: selection.fork } : {}),
          ...(selection.metadata ? { sessionMetadata: selection.metadata } : {}),
          ...(selection.sessionId ? { sessionId: selection.sessionId } : {}), resume: selection.resume });
        if (gitWorkspace && !gitWorkspace.readOnly && (await gitWorkspace.status()).state !== "unmanaged" &&
            !(await gitWorkspace.checkpoints(app.sessionId)).some(checkpoint => checkpoint.status !== "failed")) {
          try { await gitWorkspace.prepare(app.sessionId); }
          catch (error) { await app.close(); throw error; }
        }
        state.options = nextOptions;
        return app;
      },
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.autoResume === undefined
        ? {}
        : { autoResume: options.autoResume }),
    });
    const product = new MaybeCodeWorkspace(state, manager);
    await product.syncWorktreeProcess();
    return product;
  }

  get sessionId(): string {
    return this.manager.sessionId;
  }

  get workspace(): string { return this.manager.workspace; }

  private get git(): ProjectGitWorkspace | undefined { return this.state.git.get(this.workspace); }

  async getWorkspaceGit(): Promise<UiWorkspaceGit> {
    if (!this.git) return { path: this.workspace, status: "disabled", autoCommit: false };
    try {
      const status = await this.git.status();
      return { path: this.workspace, status: status.state === "unborn" ? "initializing" : status.state === "unmanaged" ? "disabled" : "ready",
        autoCommit: status.autoCommit && !status.readOnly, detached: status.detached,
        ...(status.branch ? { branch: status.branch } : {}), ...(status.commit ? { commit: status.commit } : {}) };
    } catch (error) {
      return { path: this.workspace, status: "error", autoCommit: this.git.autoCommit, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getForkPoints(sessionId?: string): Promise<readonly UiForkPoint[]> {
    const nodes = await this.manager.readSessionBranchTree();
    const checkpoints = await this.git?.checkpoints() ?? [];
    const sessions = await this.listSessions();
    const worktrees = await this.git?.listWorktrees() ?? [];
    const checkpointFor = (sourceId: string, runId: string): import("@may/application/git-workspace").GitCheckpoint | undefined => {
      const seen = new Set<string>();
      while (!seen.has(sourceId)) {
        seen.add(sourceId);
        const checkpoint = [...checkpoints].reverse().find(item => item.sessionId === sourceId && (item.runId === runId || item.runIds?.includes(runId)));
        if (checkpoint) return checkpoint;
        const source = nodes.find(node => node.sessionId === sourceId)?.fork;
        if (!source) return undefined;
        sourceId = source.sessionId;
      }
      throw new Error("Session branch lineage contains a cycle");
    };
    return nodes.flatMap(node => {
      if (sessionId && node.sessionId !== sessionId) return [];
      const workspace = sessions.find(session => session.id === node.sessionId)?.workspace;
      const worktree = worktrees.find(tree => tree.workspace === workspace);
      const workspaceReady = worktree === undefined || worktree.status === "ready";
      return node.positions.map((position, index) => {
        const checkpoint = checkpointFor(node.sessionId, position.runId);
        const completeRequest = checkpoint?.runIds?.length ? checkpoint.runId === position.runId : true;
        const parent = index ? node.positions[index - 1] : undefined;
        return { id: `${node.sessionId}:${position.positionSeq}`, sessionId: node.sessionId, runId: position.runId,
          createdAt: position.timestamp, userPreview: position.request, assistantPreview: position.response,
          available: position.available && completeRequest && workspaceReady,
          ...(!workspaceReady ? { reason: "The managed worktree did not finish initialization; inspect its diagnostic" } :
            !completeRequest ? { reason: "The selected Run belongs to an unfinished part of this request" } : position.reason ? { reason: position.reason } : {}),
          ...(parent ? { parentPointId: `${node.sessionId}:${parent.positionSeq}` } : node.fork ? { parentPointId: `${node.fork.sessionId}:${node.fork.positionSeq}` } : {}),
          ...(checkpoint?.commit ? { commit: checkpoint.commit } : {}), ...(checkpoint?.branch ? { branch: checkpoint.branch } : {}),
          worktreeAvailable: position.available && completeRequest && workspaceReady && this.git?.readOnly !== true && checkpoint?.commit !== undefined && ["committed", "unchanged"].includes(checkpoint.status) };
      });
    });
  }

  async forkSession(pointId: string, mode: "current" | "worktree"): Promise<string> {
    return this.runWorkspaceOperation(() => this.forkWorkspaceSession(pointId, mode));
  }

  private async forkWorkspaceSession(pointId: string, mode: "current" | "worktree"): Promise<string> {
    const point = (await this.getForkPoints()).find(item => item.id === pointId);
    if (!point?.available) throw new Error(point?.reason ?? "Session history position is unavailable");
    const positionSeq = Number(point.id.slice(point.sessionId.length + 1));
    const git = this.git;
    const checkpoint = await this.checkpointForRun(point.sessionId, point.runId);
    const sourceWorkspace = (await this.listSessions()).find(session => session.id === point.sessionId)?.workspace;
    if (!sourceWorkspace) throw new Error("Source Session workspace is unavailable");
    let tree: Awaited<ReturnType<ProjectGitWorkspace["createWorktree"]>> | undefined;
    if (mode === "worktree") {
      if (!git || !checkpoint?.commit || !point.worktreeAvailable) throw new Error("Selected reply has no complete Git checkpoint");
      tree = await git.createWorktree({ sessionId: point.sessionId, historyPosition: positionSeq, checkpointId: checkpoint.id });
    }
    let sessionId: string;
    try {
      sessionId = await this.manager.forkSession(point.sessionId, positionSeq, {
        ...(tree ? { workspace: tree.workspace } : {}),
        metadata: { workspaceFork: { mode, sourceWorkspace, sourceCommit: point.commit ?? null,
          ...(tree ? { worktreeId: tree.id } : { currentFiles: true }) } },
      });
      if (tree) await git!.attachWorktreeSession(tree.id, sessionId);
      await this.syncWorktreeProcess();
    } catch (error) {
      if (tree) await git!.failWorktree(tree.id, error);
      throw error;
    }
    this.connectMcpEvents();
    return sessionId;
  }

  async getCheckpoints(sessionId = this.sessionId): Promise<readonly UiCheckpoint[]> {
    const points = await this.getForkPoints(sessionId);
    const checkpoints = await this.git?.checkpoints() ?? [];
    const sourceIds = [sessionId];
    while (true) {
      const created = (await this.manager.readSessionHistory(sourceIds[sourceIds.length - 1]!))[0];
      if (created?.type !== "session.created" || !created.fork) break;
      if (sourceIds.includes(created.fork.sessionId)) throw new Error("Session branch lineage contains a cycle");
      sourceIds.push(created.fork.sessionId);
      if (!(await this.listSessions()).some(session => session.id === created.fork!.sessionId)) break;
    }
    return points.map(point => {
      let checkpoint: import("@may/application/git-workspace").GitCheckpoint | undefined;
      for (const sourceId of sourceIds) {
        checkpoint = [...checkpoints].reverse().find(item => item.sessionId === sourceId && (item.runId === point.runId || item.runIds?.includes(point.runId)));
        if (checkpoint) break;
      }
      return { runId: point.runId, pointId: point.id,
        ...(checkpoint?.fromCommit ? { startCommit: checkpoint.fromCommit } : {}), ...(checkpoint?.commit ? { endCommit: checkpoint.commit } : {}),
        ...(checkpoint?.branch ? { branch: checkpoint.branch } : {}),
        status: checkpoint?.status === "failed" ? "failed" as const : !checkpoint || checkpoint.status === "uncommitted" ? "unavailable" as const : "saved" as const,
        ...(checkpoint?.error ? { error: checkpoint.error } : {}),
      };
    });
  }

  private async checkpointForRun(sessionId: string, runId: string): Promise<import("@may/application/git-workspace").GitCheckpoint | undefined> {
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
    return ((await this.git?.listWorktrees()) ?? []).filter(tree => tree.status !== "deleted").map(tree => ({
      id: tree.id, path: tree.workspace, branch: tree.branch, sourceSessionId: tree.sourceSessionId,
      pointId: `${tree.sourceSessionId}:${tree.historyPosition}`, commit: tree.commit, sessionIds: tree.sessions,
      status: tree.status === "failed" ? "error" : tree.status === "creating" ? "creating" : "ready", ...(tree.error ? { error: tree.error } : {}),
    }));
  }

  async openWorktree(id: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.openWorkspaceWorktree(id));
  }

  private async openWorkspaceWorktree(id: string): Promise<void> {
    const tree = (await this.getWorktrees()).find(item => item.id === id);
    if (!tree || tree.status !== "ready") throw new Error("Managed worktree is unavailable");
    const session = (await this.listSessions()).find(item => tree.sessionIds.includes(item.id));
    if (!session) throw new Error("Worktree has no available Session");
    await this.resumeWorkspaceSession(session.id);
  }

  async deleteWorktree(id: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.deleteWorkspaceWorktree(id));
  }

  private async deleteWorkspaceWorktree(id: string): Promise<void> {
    const git = this.requireGit();
    const tree = (await git.listWorktrees()).find(item => item.id === id);
    if (!tree) throw new Error("Managed worktree is unavailable");
    if (tree.workspace === this.workspace) throw new Error("Switch to another workspace before deleting this worktree");
    for (const sessionId of tree.sessions) {
      if ((await this.listSessions()).some(session => session.id === sessionId)) throw new Error("Delete or move associated Sessions before deleting this worktree");
      await git.attachWorktreeSession(id, sessionId, false);
    }
    await git.deleteWorktree(id);
  }

  async getChanges(query: { readonly scope: "run" | "session" | "workspace"; readonly runId?: string; readonly commit?: string }): Promise<UiWorkspaceDiff> {
    const git = this.requireGit();
    const checkpoints = await git.checkpoints(this.sessionId);
    let from: string | undefined;
    let to: string | undefined;
    if (query.scope === "run") {
      if (!query.runId) throw new Error("Run changes require a runId");
      const checkpoint = await this.checkpointForRun(this.sessionId, query.runId);
      from = checkpoint?.fromCommit; to = checkpoint?.status === "uncommitted" || checkpoint?.status === "failed" ? undefined : checkpoint?.commit;
    } else if (query.scope === "session") {
      const last = checkpoints[checkpoints.length - 1];
      from = checkpoints[0]?.commit; to = last?.status === "uncommitted" || last?.status === "failed" ? undefined : last?.commit;
    } else from = query.commit ?? (await git.status()).commit;
    if (!from) throw new Error("Git comparison has no available initial version");
    const diff = await git.diff({ from, ...(to ? { to } : {}) });
    const files = diff.files.map(file => ({ path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status === "typechanged" || file.status === "unknown" ? "modified" as const : file.status,
      binary: file.binary, additions: file.insertions, deletions: file.deletions, patch: file.patch }));
    return { scope: query.scope, title: query.scope === "run" ? "本轮文件变化" : query.scope === "session" ? "Session 文件变化" : "当前工作区文件变化",
      from: diff.from, ...(diff.to ? { to: diff.to } : {}), ...(query.runId ? { runId: query.runId } : {}), uncommitted: !diff.to, files };
  }

  async previewRestore(runId: string, paths: readonly string[]): Promise<{ previewId: string; diff: UiWorkspaceDiff }> {
    return this.runWorkspaceOperation(() => this.previewWorkspaceRestore(runId, paths));
  }

  private async previewWorkspaceRestore(runId: string, paths: readonly string[]): Promise<{ previewId: string; diff: UiWorkspaceDiff }> {
    const git = this.requireGit();
    if (git.readOnly) throw new Error("File restoration is disabled in a read-only workspace");
    const checkpoint = await this.checkpointForRun(this.sessionId, runId);
    if (!checkpoint) throw new Error("Run has no Git checkpoint");
    const preview = await git.previewRestore({ checkpointId: checkpoint.id, paths });
    const previewId = randomUUID();
    this.restorePreviews.clear();
    this.restorePreviews.set(previewId, { sessionId: this.sessionId, preview });
    return { previewId, diff: { scope: "run", runId, title: "文件恢复预览", to: preview.commit,
      uncommitted: true, restorePreviewId: previewId, files: preview.files.map(file => ({
        path: file.path, status: file.targetMode === undefined ? "deleted" : file.beforeFingerprint === undefined ? "added" : "modified",
        binary: file.binary, additions: 0, deletions: 0, patch: file.patch,
      })) } };
  }

  async restoreFiles(previewId: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.manager.runStateTransition(() => this.restoreWorkspaceFiles(previewId)));
  }

  private async restoreWorkspaceFiles(previewId: string): Promise<void> {
    const saved = this.restorePreviews.get(previewId);
    if (!saved || saved.sessionId !== this.sessionId || saved.preview.workspace !== this.workspace) throw new Error("File restore preview is no longer available");
    try {
      const checkpoint = await this.requireGit().restore(saved.preview, { sessionId: this.sessionId, commitMessage: "Restore selected files from a session checkpoint" });
      this.restorePreviews.delete(previewId);
      this.eventQueue.push({ type: "workspace.git.changed", checkpoint });
    } catch (error) {
      if (error instanceof GitCheckpointError) this.eventQueue.push({ type: "workspace.git.changed", checkpoint: error.checkpoint });
      throw error;
    }
  }

  private requireGit(): ProjectGitWorkspace {
    if (!this.git) throw new Error("Git workspace management is disabled");
    return this.git;
  }

  private assertWorkspaceIdle(): void {
    this.throwIfClosed();
    if (this.isRunning || this.getGoal()?.status === "active" || this.getMcpInteractions().length) throw new Error("Finish the active operation before changing the workspace");
  }

  private assertNoWorkspaceOperation(): void {
    this.throwIfClosed();
    if (this.workspaceOperation) throw new GitWorkspaceConflictError("Finish the active workspace operation before changing Session state");
  }

  private runWorkspaceOperation<T>(work: () => Promise<T>, requireIdle = true): Promise<T> {
    if (requireIdle) this.assertWorkspaceIdle(); else this.assertNoWorkspaceOperation();
    if (this.getGoal()?.status === "active") throw new GitWorkspaceConflictError("Pause or finish the active Goal before changing the workspace");
    const previousSessionId = this.sessionId;
    const previousOptions = this.state.options;
    const operation = Promise.resolve().then(work).catch(error => {
      if (this.sessionId === previousSessionId) this.state.options = previousOptions;
      throw error;
    });
    this.workspaceOperation = operation;
    return operation.finally(() => { if (this.workspaceOperation === operation) this.workspaceOperation = undefined; });
  }

  private async syncWorktreeProcess(): Promise<void> {
    const git = this.state.git.get(this.state.rootWorkspace);
    if (!git || git.readOnly) return;
    const tree = (await git.listWorktrees()).find(item => item.workspace === this.workspace && item.status === "ready");
    if (this.worktreeProcessId && this.worktreeProcessId !== tree?.id) await git.trackWorktreeProcess(this.worktreeProcessId, process.pid, false);
    this.worktreeProcessId = tree?.id;
    if (tree) {
      await git.attachWorktreeSession(tree.id, this.sessionId);
      await git.trackWorktreeProcess(tree.id, process.pid);
    }
  }

  get permissionMode(): MaybeCodePermissionMode {
    return this.state.options.permissionMode ?? "default";
  }

  async setPermissionMode(mode: MaybeCodePermissionMode): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    parsePermissionMode(mode);
    await this.manager.runStateTransition(() => {
      if (mode === this.permissionMode) return;
      if (this.isRunning || this.getGoal()?.status === "active" || this.getMcpInteractions().length > 0) {
        throw new Error("Pause or cancel the current operation before changing permission mode");
      }
      this.state.options = { ...this.state.options, permissionMode: mode };
      this.eventQueue.push({ type: "permission-mode.changed", mode });
    }, { activeOperationMessage: "Pause or cancel the current operation before changing permission mode" });
  }

  get isRunning(): boolean {
    return this.workspaceOperation !== undefined || this.manager.isRunning || this.mcpOperationController !== undefined || this.pendingInputs.size > 0 || this.pendingSteering > 0;
  }

  get instructions(): MaybeCodeInstructions {
    return this.manager.activeApplication.instructions;
  }

  listSkills() {
    const skills = this.manager.activeApplication.skills;
    const active = new Map(skills?.listActive().map((item) => [item.name, item]));
    const all = new Map(skills?.registry.list().map((item) => [item.name, item]));
    for (const [name, item] of active) all.set(name, item);
    return [...all.values()].map((item) => ({ ...item, active: active.has(item.name) }));
  }

  getSkillDiagnostics() { return this.manager.activeApplication.skills?.registry.diagnostics ?? []; }

  readSkill(name: string) {
    this.assertNoWorkspaceOperation();
    return this.manager.runStateTransition(async (app) => {
      if (!app.skills) throw new Error("Skills are disabled");
      return app.skills.listActive().find((item) => item.name === name) ?? app.skills.registry.load(name);
    }, { requireIdle: false });
  }

  activateSkill(name: string) {
    this.assertNoWorkspaceOperation();
    return this.manager.runStateTransition((app) => app.activateSkill(name));
  }

  submitSkill(name: string, input: string): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    return this.manager.submitPrepared(async () => {
      await this.manager.activeApplication.activateSkill(name);
      return { input: `Use the ${name} skill for this task:\n${input}` };
    });
  }

  get modelInfo(): MaybeCodeModelInfo | undefined {
    return this.manager.activeApplication.modelInfo;
  }

  async getMcpStatus(): Promise<readonly McpServerStatus[]> {
    this.throwIfClosed();
    return this.mcp?.status() ?? [];
  }

  private get mcp(): MaybeCodeWorkspaceOptions["mcp"] {
    return this.manager.activeApplication.mcp ?? this.state.options.mcp;
  }

  getMcpInteractions() {
    const interactions = this.mcp?.interactions;
    if (interactions === undefined) return [];
    return [
      this.mcpOwner(),
      ...this.delegatedSessions().map((sessionId) => ({ workspaceId: this.workspace, sessionId })),
    ].flatMap((owner) => [...interactions.list(owner)]);
  }

  respondMcpInteraction(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean {
    // Deliberately bypass the Session transition queue: submitPrepared/Run may
    // be waiting for this answer while holding that queue.
    if (this.closed) return false;
    const request = this.getMcpInteractions().find((entry) => entry.id === id);
    return request === undefined ? false : this.mcp!.interactions!.respond(id, request.owner, response);
  }

  private mcpOwner() { return { workspaceId: this.workspace, sessionId: this.sessionId }; }

  /** 活动请求的子 Session 保留自己的 MCP 身份与授权记录。 */
  private delegatedSessions(): readonly string[] {
    return this.manager.activeApplication.ownedDelegatedSessions();
  }

  ownsSession(sessionId: string): boolean {
    return sessionId === this.sessionId || this.manager.activeApplication.ownsSession(sessionId);
  }

  async refreshMcp(serverId?: string): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    const mcp = this.mcp;
    if (mcp?.refresh === undefined) throw new Error("MCP refresh is unavailable");
    await mcp.refresh(serverId);
  }

  async reconnectMcp(serverId: string): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    const mcp = this.mcp;
    if (mcp?.reconnect === undefined) throw new Error("MCP reconnect is unavailable");
    await mcp.reconnect(serverId);
  }

  getMcpCatalog() {
    this.throwIfClosed();
    return this.mcp?.catalog?.() ?? [];
  }

  listMcpTasks() {
    this.throwIfClosed();
    return this.mcp?.listTasks?.(this.mcpOwner()) ?? Promise.resolve([]);
  }
  getMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("getTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  updateMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskUpdateOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("updateTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  waitMcpTask(serverId: string, id: string, options: McpOperationOptions & McpTaskWaitOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("waitTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  cancelMcpTask(serverId: string, id: string, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("cancelTask")(serverId, id, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }
  forgetMcpTask(serverId: string, id: string) {
    return this.mcpOperation(() => this.manager.runStateTransition(() => this.mcpMethod("forgetTask")(serverId, id, this.mcpOwner())));
  }
  submitMcpTask(serverId: string, id: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpTaskToUserMessage(await this.mcpMethod("getTask")(serverId, id, { signal, owner: this.mcpOwner() }), instruction), signal,
    })));
  }

  readMcpResource(serverId: string, uri: string, options: McpReadOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("readResource")(serverId, uri, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  readMcpResourceTemplate(serverId: string, template: string, variables: Readonly<Record<string, string | string[]>>, options: McpReadOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("readResourceTemplate")(serverId, template, variables, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  getMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("getPrompt")(serverId, name, args, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  completeMcp(serverId: string, params: McpCompletionParams, options: McpOperationOptions = {}) {
    return this.mcpOperation((signal) => this.manager.runStateTransition(() => this.mcpMethod("complete")(serverId, params, { ...options, signal, owner: this.mcpOwner() })), options.signal);
  }

  submitMcpResource(serverId: string, uri: string, instruction?: string): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpResourceToUserMessage(await this.mcpMethod("readResource")(serverId, uri, { signal, owner: this.mcpOwner() }), instruction), signal,
    })));
  }

  submitMcpPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<MaybeCodeRun> {
    return this.mcpOperation((signal) => this.manager.submitPrepared(async () => ({
      input: mcpPromptToUserMessage(await this.mcpMethod("getPrompt")(serverId, name, args, { signal, owner: this.mcpOwner() })), signal,
    })));
  }

  watchMcpResource(serverId: string, uri: string): Promise<McpResourceSubscription> {
    return this.mcpOperation(async (signal) => {
      const owner = this.mcpOwner();
      const key = JSON.stringify([owner.workspaceId, owner.sessionId, serverId, uri]);
      if (this.mcpWatches.has(key)) return this.mcpWatches.get(key)!;
      const watch = await this.mcpMethod("subscribeResource")(serverId, uri, { signal, owner: this.mcpOwner() });
      this.mcpWatches.set(key, watch);
      void (async () => {
        for await (const event of watch.events) {
          if (!this.closed && owner.workspaceId === this.workspace && owner.sessionId === this.sessionId) this.eventQueue.push({ type: "mcp.resource.updated", serverId, uri: event.uri });
        }
        const reason = await watch.closed;
        if (this.mcpWatches.get(key) === watch) this.mcpWatches.delete(key);
        if (!this.closed && owner.workspaceId === this.workspace && owner.sessionId === this.sessionId) this.eventQueue.push({ type: "mcp.resource.watch-closed", serverId, uri, reason });
      })();
      return watch;
    });
  }

  async unwatchMcpResource(serverId: string, uri: string): Promise<void> {
    this.throwIfClosed();
    await this.mcpWatches.get(JSON.stringify([this.workspace, this.sessionId, serverId, uri]))?.close();
  }

  private mcpMethod<K extends "readResource" | "readResourceTemplate" | "getPrompt" | "complete" | "subscribeResource" | "getTask" | "updateTask" | "waitTask" | "cancelTask" | "forgetTask">(method: K): McpClientPool[K] {
    const mcp = this.mcp;
    if (mcp?.[method] === undefined) throw new Error(`MCP ${method} is unavailable`);
    return mcp[method].bind(mcp) as McpClientPool[K];
  }

  private async mcpOperation<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.throwIfClosed();
    if (this.isRunning) throw new Error("Cannot start an MCP user operation while another operation is active");
    const controller = new AbortController();
    this.mcpOperationController = controller;
    const signal = AbortSignal.any([controller.signal, this.mcpLifetime.signal, ...(external === undefined ? [] : [external])]);
    try { signal.throwIfAborted(); return await work(signal); }
    finally { if (this.mcpOperationController === controller) this.mcpOperationController = undefined; }
  }

  async submit(options: SessionSubmitOptions): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    const controller = new AbortController();
    this.pendingInputs.add(controller);
    try {
      return await this.manager.submit({ ...options, signal: options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]) });
    } finally { this.pendingInputs.delete(controller); }
  }

  async steer(options: SessionSteerOptions) {
    this.assertNoWorkspaceOperation();
    const epoch = this.inputEpoch;
    this.pendingSteering++;
    try {
      return await this.manager.runStateTransition(app => {
        if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before acceptance");
        return app.steer(options);
      }, { requireIdle: false });
    } finally { this.pendingSteering--; }
  }

  listSteeringInputs() { return this.manager.activeApplication.listSteeringInputs(); }

  getGoal() { return this.manager.activeApplication.getGoal(); }
  startGoal(objective: string, budget?: import("@may/goal").GoalBudget) {
    this.assertNoWorkspaceOperation();
    return this.manager.runStateTransition(app => app.startGoal(objective, budget));
  }
  resumeGoal() { this.assertNoWorkspaceOperation(); return this.manager.runStateTransition(app => app.resumeGoal()); }
  pauseGoal() { return this.manager.runStateTransition(app => app.pauseGoal(), { requireIdle: false }); }
  cancelGoal() { return this.manager.runStateTransition(app => app.cancelGoal(), { requireIdle: false }); }

  retry(): Promise<MaybeCodeRun> {
    this.assertNoWorkspaceOperation();
    return this.manager.retry();
  }

  cancel(reason?: string): boolean {
    this.inputEpoch++;
    const pending = this.pendingInputs.size > 0 || this.pendingSteering > 0 || this.mcpOperationController !== undefined;
    for (const controller of this.pendingInputs) controller.abort(new RunCancelledError(reason ?? "Input cancelled before execution"));
    this.mcpOperationController?.abort(reason);
    return this.manager.cancel(reason) || pending;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    return this.manager.resolveApproval(requestId, decision);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.manager.listSessions();
  }

  async readSessionHistory(sessionId: string) { return mediaHistory(await this.manager.readSessionHistory(sessionId)); }

  async newSession(): Promise<string> {
    return this.runWorkspaceOperation(() => this.newWorkspaceSession(), false);
  }

  private async newWorkspaceSession(): Promise<string> {
    const sessionId = await this.manager.newSession();
    await this.syncWorktreeProcess();
    this.connectMcpEvents();
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    return this.runWorkspaceOperation(() => this.resumeWorkspaceSession(sessionId), false);
  }

  private async resumeWorkspaceSession(sessionId: string): Promise<void> {
    await this.manager.resumeSession(sessionId);
    await this.syncWorktreeProcess();
    this.connectMcpEvents();
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
    if (deleted && this.git) for (const tree of await this.git.listWorktrees()) {
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
    const selected = (this.state.options.modelProfiles ?? []).find((candidate) =>
      candidate.name === profile
    );
    if (selected === undefined) throw new Error(`Unknown model profile "${profile}"`);

    if (this.modelInfo?.profile === profile) {
      return this.manager.runStateTransition((application) => {
        const model = application.modelInfo;
        if (model === undefined) {
          throw new Error("The active application does not expose model information");
        }
        this.manager.emit({ type: "model.changed", model });
        return model;
      }, {
        activeOperationMessage:
          "Cannot switch models while an operation is active",
      });
    }

    let result: MaybeCodeModelInfo | undefined;
    await this.manager.transitionApplication(async (current) => {
      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot switch models");
      }
      const configuration = await create(
        profile,
        this.modelOptionOverrides.get(profile),
      );
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
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        ...(this.git ? { gitWorkspace: this.git } : {}),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      result = configuration.modelInfo;
      return next;
    }, {
      createEvent: (application) => ({
        type: "model.changed",
        model: application.modelInfo!,
      }),
    });
    this.connectMcpEvents();
    return result!;
  }

  setDefaultModel(profile: string): Promise<void> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    return this.manager.runStateTransition(async () => {
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
    }, { requireIdle: false });
  }

  async getReasoningEffort(): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    const profile = this.modelInfo?.profile;
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
    const effectiveEffort = typeof override === "string"
      ? override
      : configured ?? (
        capabilities.status === "known"
          ? capabilities.defaultEffort
          : undefined
      );
    return {
      status: capabilities.status,
      source: capabilities.source,
      efforts: capabilities.status === "known"
        ? [...capabilities.efforts]
        : [],
      ...(capabilities.status === "known" &&
          capabilities.defaultEffort !== undefined
        ? { defaultEffort: capabilities.defaultEffort }
        : {}),
      ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
      overridden,
    };
  }

  async setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState> {
    this.assertNoWorkspaceOperation();
    this.throwIfClosed();
    await this.manager.transitionApplication(async (current) => {
      const profile = current.modelInfo?.profile;
      if (profile === undefined) {
        throw new Error("The active model has no configurable profile");
      }
      const state = await this.getReasoningEffort();
      if (effort !== undefined) {
        if (state.status === "unknown") {
          throw new Error(
            `Reasoning effort capabilities are unknown for model profile "${profile}"`,
          );
        }
        if (state.status === "unsupported") {
          throw new Error(
            `Model profile "${profile}" does not support effort-based reasoning`,
          );
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
      const configuration = await create(
        profile,
        effort === undefined ? undefined : { reasoningEffort: effort },
      );
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
        effort === undefined ? undefined : { reasoningEffort: effort },
      );
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        ...(this.git ? { gitWorkspace: this.git } : {}),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      if (effort === undefined) this.modelOptionOverrides.delete(profile);
      else this.modelOptionOverrides.set(profile, { reasoningEffort: effort });
      return next;
    });
    this.connectMcpEvents();
    return this.getReasoningEffort();
  }

  async history() {
    return mediaHistory(await this.manager.history());
  }

  listRecoveries() { return this.manager.listRecoveries(); }
  resolveRecovery(id: string, finding: string) { this.assertNoWorkspaceOperation(); return this.manager.resolveRecovery(id, finding); }

  listDelegationRequests(): readonly MaybeCodeDelegationRequest[] {
    return this.manager.activeApplication.listDelegationRequests();
  }

  getDelegationState(): MaybeCodeDelegationState | undefined {
    return this.manager.activeApplication.getDelegationState();
  }

  delegationToolRecords(taskId: string): Promise<MaybeCodeDelegationToolRecords> {
    return this.manager.activeApplication.delegationToolRecords(taskId);
  }

  resolveDelegationRecovery(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly detail: string },
  ): Promise<MaybeCodeDelegationRequest> {
    this.assertNoWorkspaceOperation();
    return this.manager.activeApplication.resolveDelegationRecovery(requestId, taskId, finding, outcome);
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.manager.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.manager.inspectContext();
  }

  compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    this.assertNoWorkspaceOperation();
    return this.manager.compactContext(strategy);
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.mcpLifetime.abort("MaybeCode workspace is closing");
    const watchesClosing = Promise.allSettled([...this.mcpWatches.values()].map((watch) => watch.close()));
    if (this.workspaceOperation) await Promise.allSettled([this.workspaceOperation]);
    const failures: unknown[] = [];
    try {
      await this.manager.close();
    } catch (error) {
      failures.push(error);
    }
    if (this.worktreeProcessId) {
      try { await this.state.git.get(this.state.rootWorkspace)!.trackWorktreeProcess(this.worktreeProcessId, process.pid, false); }
      catch (error) { failures.push(error); }
    }
    try {
      await this.state.options.closeOwnedResources?.();
    } catch (error) {
      failures.push(error);
    }
    await watchesClosing;
    try {
      await this.disconnectMcpEvents();
      await Promise.all([this.managerEventRelay, ...this.mcpEventRelays]);
    } catch (error) {
      failures.push(error);
    } finally {
      this.eventQueue.close();
    }
    failures.push(...this.mcpRelayErrors);
    if (failures.length > 0) {
      throw new AggregateError(failures, "MaybeCode workspace failed to close");
    }
  }

  private async relayEvents(events: AsyncIterable<MaybeCodeEvent>): Promise<void> {
    for await (const event of events) {
      if (event.type === "session.changed" || event.type === "model.changed") this.connectMcpEvents();
      if (event.type === "mcp.interaction.requested" &&
          (event.request.owner.workspaceId !== this.workspace || !this.ownsSession(event.request.owner.sessionId))) continue;
      this.eventQueue.push(event);
    }
  }

  private connectMcpEvents(): void {
    if (this.closed) return;
    const mcp = this.mcp;
    if (mcp === this.observedMcp) return;
    this.trackMcpRelay(this.disconnectMcpEvents());
    this.observedMcp = mcp;
    for (const events of [mcp?.events, mcp?.interactions?.events]) {
      if (events === undefined) continue;
      const iterator = events[Symbol.asyncIterator]();
      this.mcpEventIterators.add(iterator);
      this.trackMcpRelay((async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) return;
            const event = next.value;
            if (event.type === "mcp.interaction.requested" &&
                (event.request.owner.workspaceId !== this.workspace || !this.ownsSession(event.request.owner.sessionId))) continue;
            this.eventQueue.push(event);
          }
        } finally { this.mcpEventIterators.delete(iterator); }
      })());
    }
  }

  private async disconnectMcpEvents(): Promise<void> {
    const iterators = [...this.mcpEventIterators];
    this.mcpEventIterators.clear();
    this.observedMcp = undefined;
    const results = await Promise.allSettled(iterators.map(async iterator => { await iterator.return?.(); }));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "MCP event streams failed to close");
  }

  private trackMcpRelay(operation: Promise<void>): void {
    this.mcpEventRelays.add(operation);
    void operation.then(() => this.mcpEventRelays.delete(operation), error => {
      this.mcpEventRelays.delete(operation);
      this.mcpRelayErrors.push(error);
      if (!this.closed) this.cancel("MCP event forwarding failed");
    });
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
}

function withoutSelection(
  options: MaybeCodeWorkspaceOptions,
): ActiveWorkspaceOptions {
  const { sessionId: _sessionId, autoResume: _autoResume, ...base } = options;
  return base;
}

function workspaceStoragePaths(options: ActiveWorkspaceOptions, workspace: string): string[] {
  const store = options.store as { readonly directory?: unknown };
  const catalog = options.catalog as { readonly path?: unknown };
  return [store.directory, catalog.path].filter((value): value is string => {
    if (typeof value !== "string") return false;
    const path = relative(workspace, resolve(value));
    return path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
  });
}

function applicationOptions(
  options: ActiveWorkspaceOptions,
): MaybeCodeApplicationOptions {
  const {
    permissionMode: _permissionMode,
    catalog: _catalog,
    modelProfiles: _modelProfiles,
    createModelConfiguration: _createModelConfiguration,
    resolveModelCapabilities: _resolveModelCapabilities,
    persistDefaultModel: _persistDefaultModel,
    closeOwnedResources: _closeOwnedResources,
    mcp: _mcp,
    git: _git,
    configureWorkspace: _configureWorkspace,
    ...application
  } = options;
  return application;
}

function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

function withModelConfiguration(
  options: ActiveWorkspaceOptions,
  configuration: MaybeCodeModelConfiguration,
  runtimeOptions?: Readonly<Record<string, unknown>>,
): ActiveWorkspaceOptions {
  const {
    model: _model,
    modelInfo: _modelInfo,
    contextBudget: _contextBudget,
    ...unchanged
  } = options;
  return {
    ...unchanged,
    model: configuration.model,
    modelInfo: configuration.modelInfo,
    modelRuntimeOptions: runtimeOptions ?? configuredModelOptions(options, configuration.modelInfo.profile),
    ...(configuration.contextBudget === undefined
      ? {}
      : { contextBudget: configuration.contextBudget }),
  };
}

function configuredModelOptions(options: ActiveWorkspaceOptions, profile: string | undefined): Readonly<Record<string, unknown>> {
  const effort = options.modelProfiles?.find(item => item.name === profile)?.reasoningEffort;
  return effort === undefined ? {} : { reasoningEffort: effort };
}

function readHistoricalModel(value: unknown): MaybeCodeModelInfo & { readonly runtimeOptions: Readonly<Record<string, unknown>> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaybeCodeUsageError("Historical model identity is invalid");
  const saved = value as Record<string, unknown>;
  for (const key of ["provider", "model"]) if (typeof saved[key] !== "string" || !saved[key]) throw new MaybeCodeUsageError(`Historical model ${key} is invalid`);
  for (const key of ["profile", "adapter"]) if (saved[key] !== undefined && typeof saved[key] !== "string") throw new MaybeCodeUsageError(`Historical model ${key} is invalid`);
  if (!saved.runtimeOptions || typeof saved.runtimeOptions !== "object" || Array.isArray(saved.runtimeOptions)) throw new MaybeCodeUsageError("Historical model options are invalid");
  return saved as unknown as MaybeCodeModelInfo & { readonly runtimeOptions: Readonly<Record<string, unknown>> };
}

function assertHistoricalModel(saved: MaybeCodeModelInfo, current: MaybeCodeModelInfo | undefined): void {
  if (!current || saved.provider !== current.provider || saved.model !== current.model || saved.adapter !== current.adapter) {
    throw new MaybeCodeUsageError("The selected history position requires its original provider, model and adapter configuration");
  }
}
