import { createHash, randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { createPatch, diffLines } from "diff";

export interface ProjectGitWorkspaceOptions {
  readonly workspace: string;
  readonly autoCommit?: boolean;
  readonly readOnly?: boolean;
  readonly dataRoot?: string;
  readonly worktreesRoot?: string;
  readonly excludedPaths?: readonly string[];
  readonly authorizeCommit?: (request: GitCommitRequest) => boolean | Promise<boolean>;
}

export interface GitCommitRequest {
  readonly workspace: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly initial: boolean;
  readonly message: string;
  readonly paths: readonly string[];
}

export interface GitWorkspaceStatus {
  readonly workspace: string;
  readonly repository?: string;
  readonly projectId: string;
  readonly autoCommit: boolean;
  readonly readOnly: boolean;
  readonly state: "unmanaged" | "unborn" | "ready";
  readonly branch?: string;
  readonly commit?: string;
  readonly detached: boolean;
  readonly dirty: boolean;
}

export interface GitCheckpoint {
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly historyPosition?: number | string;
  readonly workspace: string;
  readonly repository: string;
  readonly fromCommit?: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly status: "committed" | "unchanged" | "uncommitted" | "failed";
  readonly createdAt: number;
  readonly recovered?: boolean;
  readonly error?: string;
}

export interface GitRoundOptions {
  readonly sessionId: string;
  readonly runId?: string;
  readonly historyPosition?: number | string;
}

export interface GitRoundCompletion {
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly commitMessage?: string;
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly historyPosition?: number | string;
}

export interface GitRoundLease {
  readonly fromCommit?: string;
  complete(options: GitRoundCompletion): Promise<GitCheckpoint>;
  close(): Promise<void>;
}

export interface GitWorkspaceDiff {
  readonly from: string;
  readonly to?: string;
  readonly patch: string;
  readonly files: readonly GitDiffFile[];
  readonly insertions: number;
  readonly deletions: number;
  readonly untracked: readonly string[];
}

export interface GitDiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged" | "untracked" | "unknown";
  readonly patch: string;
  readonly binary: boolean;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitRestorePreview {
  readonly checkpointId: string;
  readonly commit: string;
  readonly workspace: string;
  readonly files: readonly GitRestoreFile[];
}

export interface GitRestoreFile {
  readonly path: string;
  readonly beforeFingerprint?: string;
  readonly targetMode?: "100644" | "100755";
  readonly contentBase64?: string;
  readonly binary: boolean;
  readonly patch: string;
}

export interface GitRestoreOptions {
  readonly sessionId: string;
  readonly runId?: string;
  readonly historyPosition?: number | string;
  readonly commitMessage?: string;
}

export interface ManagedGitWorktree {
  readonly id: string;
  readonly projectId: string;
  readonly repository: string;
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly historyPosition: number | string;
  readonly checkpointId: string;
  readonly commit: string;
  readonly path: string;
  readonly workspace: string;
  readonly branch: string;
  readonly sessions: readonly string[];
  readonly processes: readonly number[];
  readonly status: "creating" | "ready" | "failed" | "deleted";
  readonly createdAt: number;
  readonly error?: string;
}

interface CommitIntent {
  readonly checkpoint: GitCheckpoint;
  readonly phase: "planned" | "committed";
  readonly tree: string;
  readonly commit?: string;
}

export class GitCheckpointError extends Error {
  constructor(readonly checkpoint: GitCheckpoint, cause: unknown) {
    super(checkpoint.error ?? "Git checkpoint failed", { cause });
    this.name = "GitCheckpointError";
  }
}

export class GitWorkspaceConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitWorkspaceConflictError";
  }
}

/** 项目文件版本、checkpoint 和登记的 worktree 使用相同的 Git 仓库。 */
export class ProjectGitWorkspace {
  readonly workspace: string;
  readonly repository: string | undefined;
  readonly projectId: string;
  readonly autoCommit: boolean;
  readonly readOnly: boolean;
  private readonly git: SimpleGit;
  private readonly reader: SimpleGit;
  private readonly directory: string;
  private readonly worktreesRoot: string;
  private readonly options: ProjectGitWorkspaceOptions;
  private readonly commonDirectory: string;

  private constructor(options: ProjectGitWorkspaceOptions, workspace: string, repository: string | undefined, commonDirectory: string) {
    this.options = options;
    this.commonDirectory = commonDirectory;
    this.workspace = workspace;
    this.repository = repository;
    this.autoCommit = options.autoCommit !== false;
    this.readOnly = options.readOnly === true;
    this.projectId = digest(commonDirectory);
    this.git = simpleGit({ baseDir: repository ?? workspace, maxConcurrentProcesses: 1, trimmed: true,
      config: ["core.quotepath=false"], allowEnvironment: ["GIT_CEILING_DIRECTORIES"] });
    this.reader = simpleGit({ baseDir: repository ?? workspace, binary: ["git", "--no-optional-locks"],
      maxConcurrentProcesses: 1, trimmed: true, config: ["core.quotepath=false"], allowEnvironment: ["GIT_CEILING_DIRECTORIES"] });
    this.directory = join(resolve(options.dataRoot ?? join(homedir(), ".may", "git-workspaces")), this.projectId);
    this.worktreesRoot = resolve(options.worktreesRoot ?? join(homedir(), ".may", "worktrees"));
    if (repository !== undefined && (isWithin(repository, this.directory) || isWithin(repository, this.worktreesRoot))) {
      throw new Error("Git checkpoint records and managed worktrees must be stored outside the source repository");
    }
  }

  static async open(options: ProjectGitWorkspaceOptions): Promise<ProjectGitWorkspace> {
    const workspace = await realpath(resolve(options.workspace));
    if (!(await lstat(workspace)).isDirectory()) throw new Error("Git workspace must be a directory");
    const git = simpleGit({ baseDir: workspace, maxConcurrentProcesses: 1, allowEnvironment: ["GIT_CEILING_DIRECTORIES"] });
    const version = await git.version();
    if (!version.installed) throw new Error("Git is unavailable");
    if (version.major < 2 || (version.major === 2 && version.minor < 36)) throw new Error("Git 2.36 or newer is required");
    let managed = await git.checkIsRepo();
    if (!managed && options.autoCommit !== false && options.readOnly !== true) {
      await git.init();
      managed = true;
    }
    const repository = managed ? await realpath((await git.revparse(["--show-toplevel"])).trim()) : undefined;
    const commonDirectory = managed
      ? await realpath(resolve(workspace, (await git.revparse(["--git-common-dir"])).trim()))
      : workspace;
    const value = new ProjectGitWorkspace(options, workspace, repository, commonDirectory);
    if (!value.readOnly) await mkdir(value.directory, { recursive: true });
    return value;
  }

  async status(): Promise<GitWorkspaceStatus> {
    if (this.repository === undefined) {
      if (await this.reader.checkIsRepo()) throw new Error("Workspace Git repository identity changed; reopen the workspace");
      return { workspace: this.workspace, projectId: this.projectId, autoCommit: this.autoCommit,
        readOnly: this.readOnly, state: "unmanaged", detached: false, dirty: false };
    }
    await this.assertIdentity();
    const status = await this.reader.status(["--untracked-files=all"]);
    const commit = await this.head(status);
    return { workspace: this.workspace, repository: this.repository, projectId: this.projectId,
      autoCommit: this.autoCommit, readOnly: this.readOnly, state: commit === undefined ? "unborn" : "ready",
      ...(status.detached || !status.current ? {} : { branch: status.current }),
      ...(commit === undefined ? {} : { commit }), detached: status.detached, dirty: !status.isClean() };
  }

  async prepare(sessionId: string): Promise<GitCheckpoint> {
    this.requireRepository();
    const lock = await this.acquireLock();
    try {
      await this.recoverIntent();
      return await this.saveCheckpoint({ sessionId }, undefined, "Save initial workspace checkpoint", true, "completed");
    } finally { await lock.close(); }
  }

  async beginRound(options: GitRoundOptions): Promise<GitRoundLease> {
    this.requireRepository();
    const lock = await this.acquireLock();
    try {
      await this.recoverIntent();
      if (this.autoCommit && !this.readOnly) await this.assertOperational();
      const checkpoints = await this.checkpoints(options.sessionId);
      const hasInitialVersion = checkpoints.some(value => value.workspace === this.workspace &&
        ((value.commit !== undefined && (value.status === "committed" || value.status === "unchanged")) ||
          (!this.autoCommit && value.status === "uncommitted")));
      if (!hasInitialVersion) {
        await this.saveCheckpoint({ sessionId: options.sessionId }, undefined, "Save initial workspace checkpoint", true, "completed");
      }
      const fromCommit = (await this.status()).commit;
      let finished = false;
      return {
        ...(fromCommit === undefined ? {} : { fromCommit }),
        complete: async (completion) => {
          if (finished) throw new Error("Git round lease has already completed");
          finished = true;
          try {
            return await this.saveCheckpoint({ ...options,
              ...(completion.runId === undefined ? {} : { runId: completion.runId }),
              ...(completion.runIds === undefined ? {} : { runIds: completion.runIds }),
              ...(completion.historyPosition === undefined ? {} : { historyPosition: completion.historyPosition }) },
            fromCommit, completion.commitMessage ?? "Save workspace changes after agent run", false, completion.outcome);
          } finally { await lock.close(); }
        },
        close: async () => { finished = true; await lock.close(); },
      };
    } catch (error) { await lock.close(); throw error; }
  }

  async checkpoints(sessionId?: string): Promise<readonly GitCheckpoint[]> {
    const entries = await this.readRecords<GitCheckpoint>("checkpoints");
    return entries.filter(value => sessionId === undefined || value.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async bindCheckpoint(id: string, historyPosition: number | string): Promise<GitCheckpoint> {
    this.assertWritable();
    const checkpoint = await this.checkpoint(id);
    const value = { ...checkpoint, historyPosition };
    await this.writeRecord("checkpoints", id, value);
    return value;
  }

  async checkpointByRun(sessionId: string, runId: string): Promise<GitCheckpoint | undefined> {
    return [...await this.checkpoints(sessionId)].reverse().find(value => value.runId === runId || value.runIds?.includes(runId));
  }

  async checkpoint(id: string): Promise<GitCheckpoint> {
    validateId(id);
    const value = await readJson<GitCheckpoint>(join(this.directory, "checkpoints", `${id}.json`));
    if (!value || value.id !== id) throw new Error("Git checkpoint does not belong to this project");
    return value;
  }

  async diff(options: { readonly from: string; readonly to?: string; readonly file?: string }): Promise<GitWorkspaceDiff> {
    this.requireRepository();
    await this.assertIdentity();
    const from = await this.resolveCommit(options.from);
    const to = options.to === undefined ? undefined : await this.resolveCommit(options.to);
    const paths = options.file === undefined ? [] : [literalPath(this.relativeFile(options.file))];
    const args = ["--no-ext-diff", "--no-textconv", "--find-renames", from, ...(to === undefined ? [] : [to])];
    const names = await this.reader.diffSummary(["--name-status", ...args, "--", ...paths]);
    const files: GitDiffFile[] = [];
    for (const entry of names.files) {
      if (this.excluded(entry.file) || ("from" in entry && entry.from !== undefined && this.excluded(entry.from))) continue;
      const selection = [literalPath(entry.file), ...("from" in entry && entry.from !== undefined ? [literalPath(entry.from)] : [])];
      const stats = await this.reader.diffSummary(["--numstat", ...args, "--", ...selection]);
      const patch = await this.reader.diff([...args, "--", ...selection]);
      if (patch === "") throw new Error(`Git diff file path could not be resolved: ${entry.file}`);
      const status = "status" in entry ? diffStatus(entry.status) : "unknown";
      files.push({ path: entry.file, ...("from" in entry && entry.from !== undefined ? { previousPath: entry.from } : {}),
        status, patch, binary: stats.files.some(file => file.binary), insertions: stats.insertions, deletions: stats.deletions });
    }
    const untracked = to === undefined ? (await this.reader.status(["--untracked-files=all"])).not_added
      .filter(path => !this.excluded(path) && (options.file === undefined || path === this.relativeFile(options.file))) : [];
    for (const path of untracked) {
      await this.assertFileParents(path);
      const current = await regularFile(resolve(this.repository!, path));
      if (current === undefined) throw new Error("Untracked file disappeared while reading its changes");
      const binary = current.content.includes(0);
      const text = binary ? "" : current.content.toString("utf8");
      files.push({ path, status: "untracked", binary, patch: binary ? "" : createPatch(path, "", text),
        insertions: binary ? 0 : diffLines("", text).reduce((count, part) => count + (part.added ? part.count ?? 0 : 0), 0), deletions: 0 });
    }
    return { from, ...(to === undefined ? {} : { to }), patch: files.map(file => file.patch).join("\n"), files,
      insertions: files.reduce((count, file) => count + file.insertions, 0),
      deletions: files.reduce((count, file) => count + file.deletions, 0), untracked };
  }

  async previewRestore(options: { readonly checkpointId: string; readonly paths: readonly string[] }): Promise<GitRestorePreview> {
    this.requireRepository();
    await this.assertIdentity();
    const checkpoint = await this.checkpoint(options.checkpointId);
    if (!checkpoint.commit || checkpoint.status === "failed" || checkpoint.status === "uncommitted") throw new Error("Checkpoint has no complete file version");
    const commit = await this.resolveCommit(checkpoint.commit);
    if (options.paths.length === 0) throw new Error("File restoration requires an explicit path selection");
    const files: GitRestoreFile[] = [];
    for (const input of [...new Set(options.paths)]) {
      const path = this.relativeFile(input);
      if (this.excluded(path)) throw new Error("Excluded files cannot be restored through a checkpoint preview");
      await this.assertFileParents(path);
      const absolute = resolve(this.repository!, path);
      const before = await regularFile(absolute);
      const mode = (await this.reader.raw(["ls-tree", "--format=%(objectmode)", commit, "--", literalPath(path)])).trim();
      if (mode !== "" && mode !== "100644" && mode !== "100755") throw new Error(`Historical file type cannot be restored: ${path}`);
      const after = mode === "" ? undefined : await this.reader.showBuffer([`${commit}:${path}`]);
      const binary = (before?.content.includes(0) ?? false) || (after?.includes(0) ?? false);
      const patch = binary ? "" : createPatch(path, before?.content.toString("utf8") ?? "", after?.toString("utf8") ?? "");
      files.push({ path, ...(before === undefined ? {} : { beforeFingerprint: fingerprint(before.content, before.mode) }),
        ...(mode === "" ? {} : { targetMode: mode as "100644" | "100755", contentBase64: after!.toString("base64") }), binary, patch });
    }
    return { checkpointId: checkpoint.id, commit, workspace: this.workspace, files };
  }

  async restore(preview: GitRestorePreview): Promise<readonly string[]>;
  async restore(preview: GitRestorePreview, options: GitRestoreOptions): Promise<GitCheckpoint>;
  async restore(preview: GitRestorePreview, options?: GitRestoreOptions): Promise<readonly string[] | GitCheckpoint> {
    this.assertWritable();
    this.requireRepository();
    if (preview.workspace !== this.workspace) throw new Error("File restoration preview belongs to another workspace");
    const lock = await this.acquireLock();
    try {
      await this.recoverIntent();
      await this.assertOperational();
      const fromCommit = (await this.status()).commit;
      const expected = await this.previewRestore({ checkpointId: preview.checkpointId, paths: preview.files.map(file => file.path) });
      if (expected.commit !== preview.commit || expected.files.length !== preview.files.length) throw new GitWorkspaceConflictError("File restoration version has changed");
      for (let index = 0; index < expected.files.length; index += 1) {
        const current = expected.files[index]!;
        const reviewed = preview.files[index]!;
        if (current.path !== reviewed.path || current.beforeFingerprint !== reviewed.beforeFingerprint
          || current.targetMode !== reviewed.targetMode || current.contentBase64 !== reviewed.contentBase64) {
          throw new GitWorkspaceConflictError(`File changed after restoration preview: ${current.path}`);
        }
      }
      const changed: string[] = [];
      for (const file of expected.files) {
        const target = resolve(this.repository!, file.path);
        await this.assertFileParents(file.path);
        const current = await regularFile(target);
        if ((current === undefined ? undefined : fingerprint(current.content, current.mode)) !== file.beforeFingerprint) {
          throw new GitWorkspaceConflictError(`File changed during restoration: ${file.path}`);
        }
        if (file.targetMode === undefined) {
          if (current !== undefined) { await rm(target); changed.push(file.path); }
          continue;
        }
        const content = Buffer.from(file.contentBase64!, "base64");
        if (current?.content.equals(content) && (process.platform === "win32" || current.mode === file.targetMode)) continue;
        await mkdir(resolve(target, ".."), { recursive: true });
        const temporary = `${target}.${randomUUID()}.may-restore`;
        const handle = await open(temporary, "wx", file.targetMode === "100755" ? 0o755 : 0o644);
        try { await handle.writeFile(content); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, target);
        if (process.platform !== "win32") await chmod(target, file.targetMode === "100755" ? 0o755 : 0o644);
        changed.push(file.path);
      }
      return options === undefined ? changed : await this.saveCheckpoint(options, fromCommit,
        options.commitMessage ?? "Restore selected checkpoint files", false, "completed");
    } finally { await lock.close(); }
  }

  async createWorktree(options: { readonly sessionId: string; readonly historyPosition: number | string; readonly checkpointId: string }): Promise<ManagedGitWorktree> {
    this.assertWritable();
    this.requireRepository();
    await this.assertIdentity();
    const lock = await this.acquireLock("worktrees");
    try {
      const checkpoint = await this.checkpoint(options.checkpointId);
      if (checkpoint.commit === undefined || checkpoint.status === "failed" || checkpoint.status === "uncommitted") {
        throw new Error("Selected checkpoint has no complete file version");
      }
      const commit = await this.resolveCommit(checkpoint.commit);
      const id = randomUUID();
      const path = join(this.worktreesRoot, this.projectId, id);
      const branch = `may/session-${id}`;
      const workspace = join(path, relative(this.repository!, this.workspace));
      const record: ManagedGitWorktree = { id, projectId: this.projectId, repository: this.repository!,
        sourceWorkspace: this.workspace, sourceSessionId: options.sessionId, historyPosition: options.historyPosition,
        checkpointId: options.checkpointId, commit, path, workspace, branch, sessions: [], processes: [],
        status: "creating", createdAt: Date.now() };
      await mkdir(join(this.worktreesRoot, this.projectId), { recursive: true });
      if (await exists(path)) throw new Error("Worktree directory already exists");
      await this.writeRecord("worktrees", id, record);
      try {
        await this.git.raw(["worktree", "add", "--no-guess-remote", "-b", branch, path, commit]);
        const created = simpleGit({ baseDir: path, maxConcurrentProcesses: 1 });
        if ((await created.revparse(["--verify", "HEAD"])).trim() !== commit || (await created.status()).current !== branch) {
          throw new Error("Git worktree did not create the selected branch and file version");
        }
        if (!await exists(workspace)) throw new Error("Selected checkpoint does not contain the project directory");
        const value = { ...record, status: "ready" as const };
        await this.writeRecord("worktrees", id, value);
        return value;
      } catch (error) {
        await this.writeRecord("worktrees", id, { ...record, status: "failed", error: errorMessage(error) });
        throw error;
      }
    } finally { await lock.close(); }
  }

  async listWorktrees(): Promise<readonly ManagedGitWorktree[]> {
    return (await this.readRecords<ManagedGitWorktree>("worktrees")).filter(value => value.status !== "deleted")
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async attachWorktreeSession(id: string, sessionId: string, attached = true): Promise<ManagedGitWorktree> {
    return this.updateWorktree(id, record => ({ ...record,
      sessions: attached ? [...new Set([...record.sessions, sessionId])] : record.sessions.filter(value => value !== sessionId) }));
  }

  async trackWorktreeProcess(id: string, pid: number, attached = true): Promise<ManagedGitWorktree> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Worktree process PID is invalid");
    return this.updateWorktree(id, record => ({ ...record,
      processes: attached ? [...new Set([...record.processes, pid])] : record.processes.filter(value => value !== pid) }));
  }

  async failWorktree(id: string, error: unknown): Promise<ManagedGitWorktree> {
    return this.updateWorktree(id, record => ({ ...record, status: "failed", error: errorMessage(error) }));
  }

  async deleteWorktree(id: string): Promise<void> {
    this.assertWritable();
    await this.assertIdentity();
    const lock = await this.acquireLock("worktrees");
    try {
      const record = await this.worktree(id);
      const target = resolve(record.path);
      const expected = resolve(this.worktreesRoot, this.projectId, id);
      if (target !== expected || !isWithin(resolve(this.worktreesRoot, this.projectId), target)) throw new Error("Worktree path is outside its managed directory");
      if (record.status !== "ready" && record.status !== "failed") throw new Error("Only a ready or failed registered worktree can be deleted");
      if (record.sessions.length > 0) throw new GitWorkspaceConflictError("Worktree still has associated sessions");
      for (const pid of record.processes) if (processAlive(pid)) throw new GitWorkspaceConflictError("Worktree still has running processes");
      if (!await exists(target)) {
        const branches = await this.git.branchLocal();
        if (branches.all.includes(record.branch)) throw new Error("Missing worktree still has a Git branch to preserve");
        await this.writeRecord("worktrees", id, { ...record, status: "deleted" });
        return;
      }
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Worktree path has been replaced by a symbolic link");
      const actualTarget = await realpath(target);
      const actualParent = await realpath(resolve(this.worktreesRoot, this.projectId));
      if (!isWithin(actualParent, actualTarget) || actualTarget === actualParent) throw new Error("Resolved worktree path is outside its managed directory");
      const git = simpleGit({ baseDir: target, maxConcurrentProcesses: 1 });
      if (await realpath((await git.revparse(["--show-toplevel"])).trim()) !== actualTarget) throw new Error("Registered worktree identity has changed");
      const actualCommon = await realpath(resolve(target, (await git.revparse(["--git-common-dir"])).trim()));
      if (actualCommon !== this.commonDirectory) throw new Error("Registered worktree repository has changed");
      if (!(await git.status(["--untracked-files=all", "--ignored"])).isClean()) throw new GitWorkspaceConflictError("Worktree has file changes or ignored files to preserve");
      const current = (await git.status()).current;
      if (current !== record.branch) throw new Error("Registered worktree branch has changed");
      const sourceWorkspace = await realpath(record.sourceWorkspace);
      if (sourceWorkspace !== record.sourceWorkspace || !isWithin(record.repository, sourceWorkspace)) {
        throw new GitWorkspaceConflictError("Registered source workspace identity has changed");
      }
      const source = simpleGit({ baseDir: sourceWorkspace, maxConcurrentProcesses: 1 });
      const sourceRoot = await realpath((await source.revparse(["--show-toplevel"])).trim());
      const sourceCommon = await realpath(resolve(sourceWorkspace, (await source.revparse(["--git-common-dir"])).trim()));
      if (sourceRoot !== record.repository || sourceCommon !== this.commonDirectory) {
        throw new GitWorkspaceConflictError("Registered source repository identity has changed");
      }
      const sourceHead = (await source.revparse(["--verify", "HEAD^{commit}"])).trim();
      const branchHead = await git.revparse(["--verify", "HEAD"]);
      const base = (await this.git.raw(["merge-base", sourceHead, branchHead.trim()])).trim();
      if (base !== branchHead.trim()) throw new GitWorkspaceConflictError("Worktree contains commits not included in the source workspace");
      await this.git.raw(["worktree", "remove", target]);
      if (await exists(target)) throw new Error("Git worktree directory removal did not complete");
      await this.git.deleteLocalBranch(record.branch, false);
      await this.writeRecord("worktrees", id, { ...record, status: "deleted" });
    } finally { await lock.close(); }
  }

  private async saveCheckpoint(options: { sessionId: string; runId?: string; runIds?: readonly string[]; historyPosition?: number | string }, fromCommit: string | undefined,
    message: string, initial: boolean, outcome: GitRoundCompletion["outcome"]): Promise<GitCheckpoint> {
    const id = randomUUID();
    const state = await this.status();
    const base: GitCheckpoint = { id, ...options, workspace: this.workspace, repository: this.repository!,
      ...(fromCommit === undefined ? state.commit === undefined ? {} : { fromCommit: state.commit } : { fromCommit }),
      ...(state.branch === undefined ? {} : { branch: state.branch }), createdAt: Date.now(), status: "unchanged" };
    let appliedCommit: string | undefined;
    try {
      const status = await this.git.status(["--untracked-files=all"]);
      if (outcome !== "completed" || !this.autoCommit || this.readOnly) {
        const value: GitCheckpoint = { ...base, status: state.commit === undefined || !status.isClean() ? "uncommitted" : "unchanged",
          ...(state.commit === undefined ? {} : { commit: state.commit }) };
        if (!this.readOnly) await this.saveProtectedCheckpoint(value);
        return value;
      }
      await this.assertOperational();
      const paths = await this.commitPaths(status);
      const commitNeeded = state.commit === undefined || paths.length > 0;
      if (!commitNeeded) {
        const value: GitCheckpoint = { ...base, commit: state.commit!, status: "unchanged" };
        await this.saveProtectedCheckpoint(value);
        return value;
      }
      if (!/^[\x20-\x7e\r\n]+$/u.test(message) || !/[A-Za-z]/u.test(message)) throw new Error("Automatic Git commit message must be English");
      const request: GitCommitRequest = { workspace: this.workspace, sessionId: options.sessionId,
        ...(options.runId === undefined ? {} : { runId: options.runId }), initial, message, paths };
      if (this.options.authorizeCommit !== undefined && !await this.options.authorizeCommit(request)) throw new Error("Git commit authorization was rejected");
      if (paths.length > 0) await this.git.add(["--all", "--", ...paths.map(literalPath)]);
      const tree = (await this.git.raw(["write-tree"])).trim();
      const intent: CommitIntent = { checkpoint: base, phase: "planned", tree };
      await this.writeIntent(intent);
      await this.git.commit(message, [], state.commit === undefined ? { "--allow-empty": null } : {});
      const commit = await this.resolveCommit("HEAD");
      if (commit === state.commit) throw new Error("Git commit did not create a new version; inspect project Hooks and signing configuration");
      appliedCommit = commit;
      await this.writeIntent({ ...intent, phase: "committed", commit });
      const remaining = await this.commitPaths(await this.git.status(["--untracked-files=all"]));
      if (remaining.length > 0) {
        const error = new Error("Workspace changed during Git commit; the created commit is partial and working changes remain");
        await this.writeIntent({ ...intent, checkpoint: { ...base, commit, status: "failed", error: error.message }, phase: "committed", commit });
        throw error;
      }
      const value: GitCheckpoint = { ...base, commit, status: "committed" };
      await this.saveProtectedCheckpoint(value);
      await rm(this.intentPath());
      return value;
    } catch (error) {
      const value: GitCheckpoint = { ...base, ...(appliedCommit === undefined ? {} : { commit: appliedCommit }), status: "failed", error: errorMessage(error) };
      if (!this.readOnly) {
        try { await this.saveProtectedCheckpoint(value); }
        catch (persistenceError) { throw new GitCheckpointError(value, new AggregateError([error, persistenceError], "Checkpoint and failure record could not be persisted")); }
      }
      throw new GitCheckpointError(value, error);
    }
  }

  private async commitPaths(status: StatusResult): Promise<string[]> {
    const paths = new Set<string>();
    for (const path of status.not_added) {
      if (status.staged.includes(path)) throw new Error(`Staged and working content differ for ${path}`);
    }
    for (const file of status.files) {
      if (file.index !== " " && file.index !== "?" && file.working_dir !== " " && file.working_dir !== "?") {
        throw new Error(`Staged and working content differ for ${file.path}`);
      }
      for (const path of [file.path, ...(file.from === undefined ? [] : [file.from])]) {
        if (this.excluded(path)) {
          if (file.index !== " " && file.index !== "?") throw new Error(`Excluded file is staged: ${path}`);
          continue;
        }
        const absolute = resolve(this.repository!, path);
        if (!isWithin(this.repository!, absolute)) throw new Error("Git path is outside the repository");
        if (await exists(absolute) && (await lstat(absolute)).isDirectory()) {
          if (await exists(join(absolute, ".git"))) throw new Error(`Nested Git repository requires separate management: ${path}`);
        }
        paths.add(path);
      }
    }
    return [...paths];
  }

  private excluded(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
    if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return true;
    if (["credentials.json", "id_rsa", "id_ed25519", "id_ecdsa", "secrets.json", "secrets.yaml", "secrets.yml"].includes(name)) return true;
    if (/\.(?:pem|p12|pfx|key)$/iu.test(name)) return true;
    return (this.options.excludedPaths ?? []).some(value => {
      const excluded = this.relativeFile(value).replaceAll("\\", "/").replace(/\/$/u, "");
      return normalized === excluded || normalized.startsWith(`${excluded}/`);
    });
  }

  private async assertOperational(): Promise<void> {
    await this.assertIdentity();
    const status = await this.git.status();
    if (status.conflicted.length > 0) throw new Error("Git repository contains unresolved conflicts");
    for (const name of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      const path = (await this.git.revparse(["--git-path", name])).trim();
      if (await exists(resolve(this.repository!, path))) throw new Error("Git history operation is still active");
    }
    if ((await this.git.subModule(["status"])).trim() !== "") throw new Error("Git submodules require separate checkpoint management");
  }

  private async assertIdentity(): Promise<void> {
    this.requireRepository();
    const root = await realpath((await this.reader.revparse(["--show-toplevel"])).trim());
    const common = await realpath(resolve(this.repository!, (await this.reader.revparse(["--git-common-dir"])).trim()));
    if (root !== this.repository || common !== this.commonDirectory) throw new Error("Workspace Git repository identity changed; reopen the workspace");
  }

  private async recoverIntent(): Promise<void> {
    const intent = await readJson<CommitIntent>(this.intentPath());
    if (intent === undefined) return;
    const state = await this.status();
    if (state.commit === undefined) {
      if (intent.phase === "planned" && intent.checkpoint.fromCommit === undefined) {
        await rm(this.intentPath());
        return;
      }
      throw new Error("Pending checkpoint commit cannot be recovered without Git HEAD");
    }
    let commit = intent.commit;
    if (intent.phase === "planned") {
      if (state.commit === intent.checkpoint.fromCommit) {
        await rm(this.intentPath());
        return;
      }
      const tree = (await this.git.revparse([`${state.commit}^{tree}`])).trim();
      const parents = (await this.git.show(["--no-patch", "--format=%P", state.commit])).trim();
      if (tree !== intent.tree || parents !== (intent.checkpoint.fromCommit ?? "")) {
        throw new Error("Pending checkpoint requires inspection because Git history changed");
      }
      commit = state.commit;
    }
    if (commit === undefined) throw new Error("Pending checkpoint has no committed version");
    await this.resolveCommit(commit);
    const remaining = state.commit === commit ? await this.commitPaths(await this.git.status(["--untracked-files=all"])) : [];
    const incomplete = intent.checkpoint.status === "failed" || remaining.length > 0;
    await this.saveProtectedCheckpoint({ ...intent.checkpoint, commit, status: incomplete ? "failed" : "committed", recovered: true,
      ...(incomplete ? { error: intent.checkpoint.error ?? "Workspace has unsaved changes after the recovered Git commit" } : {}) });
    await rm(this.intentPath());
  }

  private async saveProtectedCheckpoint(value: GitCheckpoint): Promise<void> {
    if (value.commit !== undefined) {
      await this.git.raw(["update-ref", `refs/may/checkpoints/${value.id}`, value.commit]);
      if (value.fromCommit !== undefined) await this.git.raw(["update-ref", `refs/may/checkpoint-starts/${value.id}`, value.fromCommit]);
    }
    await this.writeRecord("checkpoints", value.id, value);
  }

  private async head(status: StatusResult): Promise<string | undefined> {
    if (status.current?.startsWith("No commits yet on ") || status.current?.startsWith("Initial commit on ")) return undefined;
    try { return await this.resolveCommit("HEAD"); }
    catch (error) {
      if (await this.reader.raw(["rev-parse", "--is-inside-work-tree"]) !== "true") throw error;
      const branches = await this.reader.branchLocal();
      if (branches.all.length === 0 && !status.detached) return undefined;
      throw error;
    }
  }

  private async resolveCommit(value: string): Promise<string> {
    if (value.startsWith("-") || value.includes("\0") || value.includes("\n")) throw new Error("Git version is invalid");
    return (await this.reader.revparse(["--verify", `${value}^{commit}`])).trim();
  }

  private relativeFile(value: string): string {
    const absolute = isAbsolute(value) ? resolve(value) : resolve(this.repository ?? this.workspace, value);
    const root = this.repository ?? this.workspace;
    if (!isWithin(root, absolute) || absolute === root) throw new Error("Git file path must remain inside the repository");
    return relative(root, absolute).replaceAll("\\", "/");
  }

  private async assertFileParents(path: string): Promise<void> {
    const absolute = resolve(this.repository!, path);
    if (path === ".git" || path.startsWith(".git/") || path.includes("/.git/")) throw new Error("Git metadata cannot be restored");
    let parent = resolve(absolute, "..");
    while (parent !== this.repository) {
      if (!isWithin(this.repository!, parent)) throw new Error("File parent is outside the repository");
      if (await exists(parent)) {
        const value = await lstat(parent);
        if (value.isSymbolicLink() || !value.isDirectory()) throw new Error("File restoration parent is not a regular directory");
      }
      parent = resolve(parent, "..");
    }
  }

  private async acquireLock(scope = digest(this.repository ?? this.workspace)): Promise<{ close(): Promise<void> }> {
    if (this.readOnly) return { close: async () => {} };
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${scope}.lock`);
    let handle: FileHandle;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const owner = await readJson<{ pid: number; hostname: string }>(path);
      if (!owner || owner.hostname !== hostname() || processAlive(owner.pid)) throw new GitWorkspaceConflictError("Git workspace is already in use by another process", { cause: error });
      const reclaimPath = `${path}.reclaim`;
      const reclaim = await open(reclaimPath, "wx", 0o600);
      try {
        const latest = await readJson<{ pid: number; hostname: string }>(path);
        if (!latest || latest.hostname !== hostname() || processAlive(latest.pid)) throw new GitWorkspaceConflictError("Git workspace lock changed during recovery");
        await rm(path);
        handle = await open(path, "wx", 0o600);
      } finally { await reclaim.close(); await rm(reclaimPath); }
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
    await handle.sync();
    let closed = false;
    return { close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
      await rm(path);
    } };
  }

  private async updateWorktree(id: string, update: (record: ManagedGitWorktree) => ManagedGitWorktree): Promise<ManagedGitWorktree> {
    this.assertWritable();
    const lock = await this.acquireLock("worktrees");
    try {
      const record = await this.worktree(id);
      if (record.status !== "ready") throw new Error("Worktree is unavailable");
      const value = update(record);
      await this.writeRecord("worktrees", id, value);
      return value;
    } finally { await lock.close(); }
  }

  private async worktree(id: string): Promise<ManagedGitWorktree> {
    validateId(id);
    const value = await readJson<ManagedGitWorktree>(join(this.directory, "worktrees", `${id}.json`));
    if (!value || value.projectId !== this.projectId || value.id !== id) throw new Error("Worktree is not registered for this project");
    return value;
  }

  private async readRecords<T>(kind: string): Promise<T[]> {
    const directory = join(this.directory, kind);
    if (!await exists(directory)) return [];
    const values: T[] = [];
    for (const name of await readdir(directory)) {
      if (name.endsWith(".json")) values.push(JSON.parse(await readFile(join(directory, name), "utf8")) as T);
    }
    return values;
  }

  private async writeRecord(kind: string, id: string, value: unknown): Promise<void> {
    validateId(id);
    await writeJson(join(this.directory, kind, `${id}.json`), value);
  }

  private intentPath(): string { return join(this.directory, `${digest(this.repository ?? this.workspace)}.intent.json`); }
  private writeIntent(value: CommitIntent): Promise<void> { return writeJson(this.intentPath(), value); }
  private requireRepository(): void { if (this.repository === undefined) throw new Error("Workspace has no Git repository"); }
  private assertWritable(): void { if (this.readOnly) throw new Error("Git workspace is read-only"); }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function validateId(value: string): void { if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error("Git record ID is invalid"); }
function literalPath(value: string): string { return `:(literal)${value}`; }
function diffStatus(value: unknown): GitDiffFile["status"] {
  switch (value) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "typechanged";
    default: return "unknown";
  }
}
function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}
function isFsError(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Git lock contains an invalid PID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (isFsError(error, "ESRCH")) return false; throw error; }
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (isFsError(error, "ENOENT")) return false; throw error; }
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if (isFsError(error, "ENOENT")) return undefined; throw error; }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.pending`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}
function fingerprint(content: Buffer, mode: string): string { return createHash("sha256").update(mode).update(content).digest("hex"); }
async function regularFile(path: string): Promise<{ content: Buffer; mode: string } | undefined> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (isFsError(error, "ENOENT")) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("File restoration supports regular files only");
  return { content: await readFile(path), mode: (stat.mode & 0o111) === 0 ? "100644" : "100755" };
}
