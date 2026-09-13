import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ResourceJournal, count, resourceId } from "./resource-journal.js";

export interface TaskWorkspaceOptions {
  readonly sourceDirectory: string;
  /** Private host state directory, outside the source tree and task tool roots. */
  readonly directory: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxTasks?: number;
  /** Additional exact basenames to exclude. Built-in exclusions cannot be loosened. */
  readonly excludeNames?: readonly string[];
}

export interface TaskWorkspace { readonly taskId: string; readonly directory: string }

export interface WorkspaceChange {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface WorkspacePatchChange extends WorkspaceChange {
  readonly taskId: string;
  readonly beforeText?: string;
  readonly afterText?: string;
}

export interface WorkspacePatchSnapshot {
  readonly sourceDirectory: string;
  readonly baselineDigest: string;
  /** Digest of every included file, not just changed paths. */
  readonly taskSnapshots: readonly { readonly taskId: string; readonly digest: string }[];
  readonly changes: readonly WorkspacePatchChange[];
}

export interface WorkspacePatchLimits {
  readonly maxChangedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

interface Entry { readonly path: string; readonly bytes: number; readonly sha256: string }
interface WorkspaceState {
  readonly format: 1;
  readonly revision: number;
  readonly source: string;
  readonly config: { readonly maxFiles: number; readonly maxBytes: number; readonly maxTasks: number; readonly excludeNames: readonly string[] };
  readonly baselineReady: boolean;
  readonly baseline: readonly Entry[];
  readonly tasks: readonly string[];
}

const excluded = new Set(["node_modules", "vendor", "dist", "build", "coverage", "target", "__pycache__",
  "data", "logs", "cache", "tmp", "temp", "secrets", "credentials", "private"]);

/** File-copy isolation, NOT a process sandbox. Never writes back to the source checkout. */
export class TaskWorkspaceManager {
  private constructor(private readonly journal: ResourceJournal<WorkspaceState>, readonly directory: string) {}

  static async open(options: TaskWorkspaceOptions): Promise<TaskWorkspaceManager> {
    const source = await realpath(resolve(options.sourceDirectory));
    if (!(await lstat(source)).isDirectory()) throw new Error("Workspace source must be a directory");
    const intended = await canonicalPotentialPath(resolve(options.directory));
    if (inside(source, intended) || inside(intended, source)) throw new Error("Task workspace state and source directories must not overlap");
    await mkdir(intended, { recursive: true });
    const directory = await realpath(resolve(options.directory));
    if (inside(source, directory) || inside(directory, source)) throw new Error("Task workspace state and source directories must not overlap");
    const config = { maxFiles: options.maxFiles ?? 10_000, maxBytes: options.maxBytes ?? 67_108_864,
      maxTasks: options.maxTasks ?? 128, excludeNames: [...(options.excludeNames ?? [])].sort() };
    count(config.maxFiles, "workspace maxFiles"); count(config.maxBytes, "workspace maxBytes"); count(config.maxTasks, "workspace maxTasks");
    for (const name of config.excludeNames) if (!name || /[\\/\u0000]/u.test(name) || name === "." || name === "..") throw new TypeError("Workspace excludeNames must be basenames");
    const initial: WorkspaceState = { format: 1, revision: 0, source, config, baselineReady: false, baseline: [], tasks: [] };
    const journal = await ResourceJournal.open(join(directory, "workspaces.jsonl"), initial,
      (state) => validate(state, source, config));
    try {
      if (!(await journal.snapshot()).baselineReady) {
        const base = join(directory, "baseline");
        // Only unpublished copies are quarantined; committed baselines remain immutable.
        await quarantineUnpublished(base, directory);
        await mkdir(base);
        const entries = await scan(source, config);
        await copyEntries(source, base, entries);
        await journal.transact((state) => ({ ...state, baselineReady: true, baseline: entries }));
      }
      return new TaskWorkspaceManager(journal, directory);
    } catch (error) { await journal.close(); throw error; }
  }

  /** Stable per logical task, including its later turns and explicitly authorized retry attempts. */
  async prepare(taskId: string): Promise<TaskWorkspace> {
    resourceId(taskId, "workspace task id");
    const directory = join(this.directory, "tasks", hash(Buffer.from(taskId)), "workspace");
    await this.journal.transact(async (state) => {
      if (state.tasks.includes(taskId)) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(this.directory, await realpath(directory))) throw new Error("Task workspace has changed identity");
        return state;
      }
      if (state.tasks.length >= state.config.maxTasks) throw new Error("Task workspace quota exceeded");
      const parent = join(this.directory, "tasks", hash(Buffer.from(taskId)));
      await mkdir(join(this.directory, "tasks"), { recursive: true });
      if ((await lstat(join(this.directory, "tasks"))).isSymbolicLink()) throw new Error("Task directory must not be a symbolic link");
      await quarantineUnpublished(parent, this.directory);
      await mkdir(parent); await mkdir(directory);
      await copyEntries(join(this.directory, "baseline"), directory, state.baseline);
      return { ...state, tasks: [...state.tasks, taskId] };
    });
    return { taskId, directory };
  }

  /** Read-only review manifest. Applying selected changes remains an explicit host/user action. */
  async changes(taskId: string): Promise<readonly WorkspaceChange[]> {
    resourceId(taskId, "workspace task id");
    const state = await this.journal.snapshot();
    if (!state.tasks.includes(taskId)) throw new Error("Task workspace is not prepared");
    const workspace = join(this.directory, "tasks", hash(Buffer.from(taskId)), "workspace");
    const current = new Map((await scan(workspace, state.config)).map((entry) => [entry.path, entry]));
    const changes: WorkspaceChange[] = [];
    for (const before of state.baseline) {
      const after = current.get(before.path); current.delete(before.path);
      if (!after) changes.push({ path: before.path, kind: "deleted", beforeSha256: before.sha256 });
      else if (after.sha256 !== before.sha256) changes.push({ path: before.path, kind: "modified", beforeSha256: before.sha256, afterSha256: after.sha256 });
    }
    for (const after of current.values()) changes.push({ path: after.path, kind: "added", afterSha256: after.sha256 });
    return changes;
  }

  /** Bounded UTF-8 review snapshot. No source writes; reject concurrent or unsafe task edits. */
  async snapshotPatch(taskIds: readonly string[], limits: WorkspacePatchLimits = {}): Promise<WorkspacePatchSnapshot> {
    const maxChangedFiles = limits.maxChangedFiles ?? 128;
    const maxFileBytes = limits.maxFileBytes ?? 262_144;
    const maxTotalBytes = limits.maxTotalBytes ?? 2_097_152;
    count(maxChangedFiles, "patch maxChangedFiles"); count(maxFileBytes, "patch maxFileBytes"); count(maxTotalBytes, "patch maxTotalBytes");
    if (!Array.isArray(taskIds) || taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) throw new Error("Select unique task ids for the patch");
    const state = await this.journal.snapshot();
    const baseline = join(this.directory, "baseline");
    await assertPrivateRoot(this.directory, baseline);
    if (!isDeepStrictEqual(await scan(baseline, state.config, true), state.baseline)) throw new Error("Workspace baseline was modified");
    const baselineDigest = hash(Buffer.from(JSON.stringify(state.baseline)));
    const changes: WorkspacePatchChange[] = [];
    const taskSnapshots: { taskId: string; digest: string }[] = [];
    let totalBytes = 0;
    const text = async (root: string, entry: Entry): Promise<string> => {
      if (entry.bytes > maxFileBytes || totalBytes + entry.bytes > maxTotalBytes) throw new Error("Patch text exceeds its byte limit");
      const content = await boundedFile(root, join(root, entry.path), entry.bytes);
      if (hash(content) !== entry.sha256) throw new Error("Workspace changed while producing its patch");
      totalBytes += content.length;
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
      if (value.includes("\u0000")) throw new Error("Binary files cannot be included in a text patch");
      return value;
    };
    for (const taskId of [...taskIds].sort()) {
      resourceId(taskId, "workspace task id");
      if (!state.tasks.includes(taskId)) throw new Error("Task workspace is not prepared");
      const workspace = join(this.directory, "tasks", hash(Buffer.from(taskId)), "workspace");
      await assertPrivateRoot(this.directory, workspace);
      const entries = await scan(workspace, state.config, true);
      const current = new Map(entries.map((entry) => [entry.path, entry]));
      for (const before of state.baseline) {
        const after = current.get(before.path); current.delete(before.path);
        if (after?.sha256 === before.sha256) continue;
        if (changes.length >= maxChangedFiles) throw new Error("Patch exceeds its changed-file limit");
        changes.push({ taskId, path: before.path, kind: after ? "modified" : "deleted", beforeSha256: before.sha256,
          beforeText: await text(baseline, before), ...(after ? { afterSha256: after.sha256, afterText: await text(workspace, after) } : {}) });
      }
      for (const after of current.values()) {
        if (changes.length >= maxChangedFiles) throw new Error("Patch exceeds its changed-file limit");
        changes.push({ taskId, path: after.path, kind: "added", afterSha256: after.sha256, afterText: await text(workspace, after) });
      }
      if (!isDeepStrictEqual(await scan(workspace, state.config, true), entries)) throw new Error("Task workspace changed during patch capture");
      taskSnapshots.push({ taskId, digest: hash(Buffer.from(JSON.stringify(entries))) });
    }
    if (!isDeepStrictEqual(await scan(baseline, state.config, true), state.baseline)) throw new Error("Workspace baseline changed during patch capture");
    return { sourceDirectory: state.source, baselineDigest, taskSnapshots, changes };
  }

  close(): Promise<void> { return this.journal.close(); }
}

function omitted(name: string, extra: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return name.startsWith(".") || excluded.has(lower) || extra.includes(name) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/u.test(lower) || /^(credentials?|secrets?|tokens?|auth)([._-].*)?$/u.test(lower);
}

async function scan(root: string, config: WorkspaceState["config"], rejectUnsafe = false): Promise<Entry[]> {
  const canonical = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Workspace root must not be a symbolic link");
  const entries: Entry[] = [];
  let bytes = 0;
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Workspace exceeds maximum directory depth");
    if (!inside(canonical, await realpath(directory)) || (await lstat(directory)).isSymbolicLink()) throw new Error("Workspace directory escaped its root");
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (omitted(entry.name, config.excludeNames)) continue;
      if (++visited > config.maxFiles * 4) throw new Error("Workspace has too many directory entries");
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      // Links, sockets and devices are never copied or followed.
      if (stat.isSymbolicLink()) { if (rejectUnsafe) throw new Error("Patch workspace contains a symbolic link"); continue; }
      if (stat.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!stat.isFile()) { if (rejectUnsafe) throw new Error("Patch workspace contains a special file"); continue; }
      if (rejectUnsafe && stat.nlink > 1) throw new Error("Patch workspace contains a hard-linked file");
      if (entries.length + 1 > config.maxFiles || bytes + stat.size > config.maxBytes) throw new Error("Workspace snapshot quota exceeded");
      const content = await boundedFile(canonical, path, stat.size);
      bytes += content.length;
      entries.push({ path: relative(canonical, path).split(sep).join("/"), bytes: content.length, sha256: hash(content) });
    }
  };
  await visit(canonical, 0);
  return entries;
}

async function copyEntries(source: string, destination: string, entries: readonly Entry[]): Promise<void> {
  for (const entry of entries) {
    const from = join(source, entry.path);
    const content = await boundedFile(source, from, entry.bytes);
    if (hash(content) !== entry.sha256) throw new Error("Workspace changed while being copied; no inconsistent copy was accepted");
    const target = join(destination, entry.path);
    if (!inside(destination, target)) throw new Error("Workspace entry escaped destination");
    await mkdir(resolve(target, ".."), { recursive: true });
    const file = await open(target, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  }
}

async function boundedFile(root: string, path: string, size: number): Promise<Buffer> {
  if (!inside(root, await realpath(path))) throw new Error("Workspace file escaped its root");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== size) throw new Error("Workspace file type/size changed");
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== size || stat.ino !== before.ino || stat.dev !== before.dev || !inside(root, await realpath(path))) throw new Error("Workspace file changed while opening");
    const bytes = Buffer.alloc(size + 1);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    if (position !== size) throw new Error("Workspace file size changed while reading");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

function inside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function assertPrivateRoot(root: string, path: string): Promise<void> {
  if (!inside(root, path) || !inside(root, await realpath(path))) throw new Error("Patch workspace escaped its private state directory");
  let cursor = root;
  for (const part of ["", ...relative(root, path).split(sep).filter(Boolean)]) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch workspace has an unsafe parent directory");
  }
}

async function canonicalPotentialPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = resolve(path, "..");
    if (parent === path) throw error;
    return join(await canonicalPotentialPath(parent), relative(parent, path));
  }
}

function validate(state: WorkspaceState, source: string, config: WorkspaceState["config"]): void {
  if (!state || state.format !== 1 || state.source !== source || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !isDeepStrictEqual(state.config, config) || typeof state.baselineReady !== "boolean" || !Array.isArray(state.baseline) || !Array.isArray(state.tasks) ||
    state.baseline.length > config.maxFiles || state.tasks.length > config.maxTasks || new Set(state.tasks).size !== state.tasks.length) throw new Error("Invalid workspace journal or changed source/policy");
  const paths = new Set<string>(); let total = 0;
  for (const entry of state.baseline) {
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.includes("\\") || entry.path.includes(":") ||
      entry.path.split("/").some((part: string) => !part || part === "." || part === ".." || omitted(part, config.excludeNames)) || isAbsolute(entry.path) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256) || paths.has(entry.path)) throw new Error("Invalid workspace baseline entry");
    paths.add(entry.path); total += entry.bytes;
  }
  if (total > config.maxBytes || (!state.baselineReady && (state.baseline.length || state.tasks.length))) throw new Error("Invalid workspace baseline");
  for (const task of state.tasks) resourceId(task, "workspace task id");
}

async function quarantineUnpublished(path: string, root: string): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(path))) throw new Error("Unsafe unpublished workspace");
  await rename(path, `${path}.quarantine-${randomUUID()}`);
}
