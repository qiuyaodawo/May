import { acquireFileLock, releaseFileLock } from "@may/session/file-store";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TaskWorkspaceManager, WorkspacePatchChange, WorkspacePatchSnapshot } from "@may/coordination";

const MAX_BUNDLE_BYTES = 16_777_216;
const MAX_FILE_BYTES = 262_144;
const MAX_TOTAL_BYTES = 2_097_152;

export interface TeamPatchFile extends Omit<WorkspacePatchChange, "taskId"> { readonly taskIds: readonly string[] }
export interface TeamPatchConflict { readonly path: string; readonly candidates: readonly TeamPatchFile[] }
interface TeamPatchPayload {
  readonly format: 1;
  readonly sourceDirectory: string;
  readonly baselineDigest: string;
  readonly taskSnapshots: WorkspacePatchSnapshot["taskSnapshots"];
  readonly files: readonly TeamPatchFile[];
  readonly conflicts: readonly TeamPatchConflict[];
}
export interface TeamPatchBundle extends TeamPatchPayload { readonly id: string; readonly digest: string }

export interface TeamPatchApplication {
  readonly status: "applied" | "unknown";
  readonly patchId: string;
  readonly digest: string;
  readonly appliedPaths: readonly string[];
  readonly uncertainPaths: readonly string[];
  readonly journalPath: string;
  readonly alreadyApplied?: boolean;
  readonly detail?: string;
}

interface ApplyRecord {
  readonly revision: number;
  readonly type: "started" | "intent" | "applied" | "completed" | "unknown";
  readonly digest: string;
  readonly path?: string;
  readonly backup?: string;
  readonly temporary?: string;
  readonly newDirectories?: readonly string[];
}

/** Persist exactly the reviewed task snapshot; conflicting changes are never silently chosen. */
export async function createTeamPatch(options: { readonly directory: string; readonly workspaces: TaskWorkspaceManager; readonly taskIds: readonly string[] }): Promise<TeamPatchBundle> {
  const bundle = bundleFrom(await options.workspaces.snapshotPatch(options.taskIds));
  if (inside(bundle.sourceDirectory, resolve(options.directory))) throw new Error("Patch storage must be outside the source workspace");
  const patches = await privateDirectory(join(resolve(options.directory), "patches"));
  const path = join(patches, `${bundle.id}.json`);
  try { await durableFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "wx"); }
  catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    if (!isDeepStrictEqual(await readTeamPatch(options.directory, bundle.id), bundle)) throw new Error("Patch id already exists with different content");
  }
  return bundle;
}

export async function readTeamPatch(directory: string, patchId: string): Promise<TeamPatchBundle> {
  assertPatchId(patchId);
  const root = await safeRoot(resolve(directory));
  const bytes = await safeRead(root, join(root, "patches", `${patchId}.json`), MAX_BUNDLE_BYTES);
  if (!bytes) throw new Error("Patch does not exist");
  const value = JSON.parse(bytes.toString("utf8")) as TeamPatchBundle;
  validateBundle(value, patchId);
  return value;
}

/** Full-file unified hunks intentionally favor exact, bounded evidence over heuristic merging. */
export function renderTeamPatchDiff(bundle: TeamPatchBundle): string {
  validateBundle(bundle, bundle.id);
  const sections = [`Patch ${bundle.id}`, `Confirm digest: ${bundle.digest}`, `Tasks: ${bundle.taskSnapshots.map((task) => task.taskId).join(", ")}`];
  for (const file of bundle.files) sections.push(fileDiff(file));
  for (const conflict of bundle.conflicts) {
    sections.push(`CONFLICT ${conflict.path}: different task results; apply is blocked.`);
    for (const file of conflict.candidates) sections.push(`Candidate tasks: ${file.taskIds.join(", ")}\n${fileDiff(file)}`);
  }
  if (bundle.files.length === 0 && bundle.conflicts.length === 0) sections.push("No source changes.");
  return `${sections.join("\n\n")}\n`;
}

/** User/host-only operation. A model tool must never invoke this API or manufacture confirmation. */
export async function applyTeamPatch(options: {
  readonly directory: string;
  readonly workspaces: TaskWorkspaceManager;
  readonly patchId: string;
  readonly confirmDigest: string;
  /** Optional host observation after the per-file result is durable. Errors stop further writes. */
  readonly onProgress?: (event: { readonly type: "file.applied"; readonly path: string }) => void;
}): Promise<TeamPatchApplication> {
  const bundle = await readTeamPatch(options.directory, options.patchId);
  if (options.confirmDigest !== bundle.digest) throw new Error("Apply requires the exact digest from the reviewed patch");
  if (bundle.conflicts.length > 0) throw new Error("Patch has conflicting task results; choose a non-conflicting task set");
  const existing = await readTeamPatchApplication(options.directory, bundle.id);
  if (existing) return { ...existing, ...(existing.status === "applied" ? { alreadyApplied: true } : {}) };
  const source = await safeRoot(bundle.sourceDirectory);
  if (source !== bundle.sourceDirectory) throw new Error("Patch source identity changed");
  const taskIds = bundle.taskSnapshots.map((task) => task.taskId);
  const checkTasks = async () => {
    const current = bundleFrom(await options.workspaces.snapshotPatch(taskIds));
    if (current.digest !== bundle.digest) throw new Error("Task or baseline snapshot changed since review; create a new patch");
  };
  await checkTasks();
  await preflight(source, bundle.files);
  // One cooperative lock per canonical source, independent of team/data directories.
  const lockDirectory = join(homedir(), ".may", "maybecode", "apply-locks");
  if (inside(source, resolve(lockDirectory))) throw new Error("Apply lock directory must be outside the source workspace");
  const locks = await privateDirectory(lockDirectory);
  if (inside(source, locks)) throw new Error("Apply lock directory must be outside the source workspace");
  const lockPath = join(locks, `${hash(source)}.lock`);
  const lock = await acquireFileLock(lockPath);
  let journal: FileHandle | undefined;
  let sequence = 0;
  const appliedPaths: string[] = [];
  let begun = false;
  const applicationDirectory = join(resolve(options.directory), "patches", "applications", bundle.id);
  const journalPath = join(applicationDirectory, "apply.jsonl");
  const append = async (record: Omit<ApplyRecord, "revision" | "digest">) => {
    await journal!.writeFile(`${JSON.stringify({ ...record, revision: sequence + 1, digest: bundle.digest })}\n`);
    await journal!.sync(); sequence++;
  };
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, patchId: bundle.id, source })}\n`); await lock.sync();
    // Closing the race with another cooperative applier is separate from task/source validation.
    const prior = await readTeamPatchApplication(options.directory, bundle.id);
    if (prior) return { ...prior, ...(prior.status === "applied" ? { alreadyApplied: true } : {}) };
    await checkTasks();
    const originals = await preflight(source, bundle.files);
    await privateDirectory(applicationDirectory);
    journal = await open(journalPath, "ax", 0o600);
    await append({ type: "started" }); begun = true;
    // Every backup is durable before any source file or source directory changes.
    const backups = await privateDirectory(join(applicationDirectory, "backups"));
    for (const file of bundle.files) {
      const original = originals.get(file.path);
      if (original) await durableFile(join(backups, `${hash(file.path)}.txt`), original, "wx");
    }
    await checkTasks();
    await preflight(source, bundle.files);
    for (const file of bundle.files) {
      // Revalidate immediately before each write. Editors that ignore the lock are not a sandboxed resource.
      await checkTasks();
      const target = checkedPath(source, file.path);
      const before = await safeRead(source, target, MAX_FILE_BYTES);
      assertBefore(file, before);
      const missing = await missingDirectories(source, dirname(target));
      const temporary = file.afterText === undefined ? undefined : join(dirname(target), `.maybecode-${bundle.id.slice(6, 18)}-${randomUUID()}.tmp`);
      await append({ type: "intent", path: file.path, ...(before ? { backup: `${hash(file.path)}.txt` } : {}),
        ...(temporary ? { temporary: relative(source, temporary).split(sep).join("/") } : {}), newDirectories: missing.map((path) => relative(source, path).split(sep).join("/")) });
      for (const path of missing) { await assertParents(source, path); await mkdir(path); }
      if (temporary) {
        await assertParents(source, target);
        const mode = before === undefined ? 0o600 : (await lstat(target)).mode & 0o777;
        const staged = await open(temporary, "wx", mode);
        try { await staged.writeFile(file.afterText!, "utf8"); await staged.sync(); }
        finally { await staged.close(); }
        assertBefore(file, await safeRead(source, target, MAX_FILE_BYTES));
        await assertParents(source, temporary);
        const stagedContent = await safeRead(source, temporary, MAX_FILE_BYTES);
        if (!stagedContent || hash(stagedContent) !== file.afterSha256) throw new Error("Staged patch content changed");
        await rename(temporary, target);
      } else {
        await assertParents(source, target);
        assertBefore(file, await safeRead(source, target, MAX_FILE_BYTES));
        await unlink(target);
      }
      // Sync the resulting file before acknowledging. Directory fsync is best-effort on Windows.
      if (file.afterText !== undefined) {
        const final = await open(target, "r+");
        try { await final.sync(); } finally { await final.close(); }
      }
      await syncDirectory(dirname(target));
      const after = await safeRead(source, target, MAX_FILE_BYTES);
      if (file.afterSha256 === undefined ? after !== undefined : after === undefined || hash(after) !== file.afterSha256) throw new Error("Source changed before the patch result was acknowledged");
      await append({ type: "applied", path: file.path }); appliedPaths.push(file.path);
      options.onProgress?.({ type: "file.applied", path: file.path });
    }
    await append({ type: "completed" });
    return { status: "applied", patchId: bundle.id, digest: bundle.digest, appliedPaths, uncertainPaths: [], journalPath };
  } catch (error) {
    if (!begun) throw error;
    // An error after the durable start is conservatively unknown, even when no effect was observed.
    try { await append({ type: "unknown" }); } catch { /* Preserve original evidence; never assume a failed journal write had no effect. */ }
    return { status: "unknown", patchId: bundle.id, digest: bundle.digest, appliedPaths,
      uncertainPaths: bundle.files.map((file) => file.path).filter((path) => !appliedPaths.includes(path)), journalPath,
      detail: error instanceof Error ? error.message : "Patch application outcome is unknown" };
  } finally {
    try { await journal?.close(); } finally { await releaseFileLock(lock, lockPath); }
  }
}

/** Incomplete/partial records are unknown evidence, never an invitation to resume source writes. */
export async function readTeamPatchApplication(directory: string, patchId: string): Promise<TeamPatchApplication | undefined> {
  const bundle = await readTeamPatch(directory, patchId);
  const root = await safeRoot(resolve(directory));
  const journalPath = join(root, "patches", "applications", patchId, "apply.jsonl");
  const bytes = await safeRead(root, journalPath, MAX_BUNDLE_BYTES);
  if (!bytes) return undefined;
  const appliedPaths: string[] = [];
  let completed = false;
  let valid = bytes.length > 0 && bytes.at(-1) === 10;
  let revision = 0;
  let last: ApplyRecord["type"] | undefined;
  const pending = new Set<string>();
  for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
    try {
      const entry = JSON.parse(line) as ApplyRecord;
      if (entry.revision !== ++revision || entry.digest !== bundle.digest || !["started", "intent", "applied", "completed", "unknown"].includes(entry.type) ||
        (revision === 1 ? entry.type !== "started" : entry.type === "started") || ["completed", "unknown"].includes(last ?? "")) throw new Error("Invalid application sequence");
      if (entry.type === "intent") {
        if (!bundle.files.some((file) => file.path === entry.path) || pending.has(entry.path!) || appliedPaths.includes(entry.path!)) throw new Error("Invalid application intent");
        pending.add(entry.path!);
      }
      if (entry.type === "applied") {
        if (!pending.delete(entry.path!)) throw new Error("Application result has no intent");
        appliedPaths.push(entry.path!);
      }
      if (entry.type === "completed") {
        if (pending.size || appliedPaths.length !== bundle.files.length) throw new Error("Application completed before all files");
        completed = true;
      }
      last = entry.type;
    } catch { valid = false; break; }
  }
  const status = valid && completed ? "applied" : "unknown";
  return { status, patchId, digest: bundle.digest, appliedPaths,
    uncertainPaths: status === "applied" ? [] : bundle.files.map((file) => file.path).filter((path) => !appliedPaths.includes(path)), journalPath,
    ...(status === "unknown" ? { detail: "Incomplete or unknown application evidence; source writes were not replayed" } : {}) };
}

/** Offline host maintenance. Deletes only recorded staging files, never source targets or backups. */
export async function cleanupTeamPatchTemporaries(options: {
  readonly directory: string;
  readonly patchId: string;
  readonly confirmDigest: string;
  readonly confirmHostsStopped: true;
}): Promise<readonly string[]> {
  if (options.confirmHostsStopped !== true) throw new Error("Patch cleanup requires stopped hosts and editors");
  const bundle = await readTeamPatch(options.directory, options.patchId);
  if (options.confirmDigest !== bundle.digest) throw new Error("Cleanup requires the exact patch digest");
  const root = await safeRoot(resolve(options.directory));
  const source = await safeRoot(bundle.sourceDirectory);
  const bytes = await safeRead(root, join(root, "patches", "applications", bundle.id, "apply.jsonl"), MAX_BUNDLE_BYTES);
  if (!bytes) return [];
  const paths = new Set<string>();
  let revision = 0;
  for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
    const entry = JSON.parse(line) as ApplyRecord;
    if (entry.revision !== ++revision || entry.digest !== bundle.digest) throw new Error("Invalid application evidence");
    if (entry.temporary === undefined) continue;
    const change = bundle.files.find((file) => file.path === entry.path);
    if (entry.type !== "intent" || change?.afterText === undefined) throw new Error("Staging file has no patch intent");
    const path = checkedPath(source, entry.temporary);
    if (dirname(path) !== dirname(checkedPath(source, change.path)) ||
      !new RegExp(`^\\.maybecode-${bundle.id.slice(6, 18)}-[a-f0-9-]{36}\\.tmp$`, "u").test(basename(path))) throw new Error("Unsafe staging path");
    if (await safeRead(source, path, MAX_FILE_BYTES) !== undefined) paths.add(path);
  }
  // Validate the entire list first. The caller guarantees no competing writers.
  for (const path of paths) { await assertParents(source, path); await unlink(path); }
  return [...paths];
}

function bundleFrom(snapshot: WorkspacePatchSnapshot): TeamPatchBundle {
  const groups = new Map<string, TeamPatchFile[]>();
  for (const { taskId, ...change } of snapshot.changes) {
    assertRelativePath(change.path);
    const group = groups.get(change.path) ?? [];
    const identical = group.find((file) => isDeepStrictEqual({ ...file, taskIds: undefined }, { ...change, taskIds: undefined }));
    if (identical) group[group.indexOf(identical)] = { ...identical, taskIds: [...identical.taskIds, taskId].sort() };
    else group.push({ ...change, taskIds: [taskId] });
    groups.set(change.path, group);
  }
  const payload: TeamPatchPayload = { format: 1, sourceDirectory: snapshot.sourceDirectory, baselineDigest: snapshot.baselineDigest,
    taskSnapshots: [...snapshot.taskSnapshots].sort((a, b) => a.taskId.localeCompare(b.taskId)), files: [], conflicts: [] };
  const files: TeamPatchFile[] = [];
  const conflicts: TeamPatchConflict[] = [];
  const aliases = new Map<string, string>();
  for (const [path, candidates] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const alias = process.platform === "win32" ? path.toLowerCase() : path;
    if (aliases.has(alias) && aliases.get(alias) !== path) throw new Error("Patch contains filesystem path aliases");
    aliases.set(alias, path);
    if (candidates.length === 1) files.push(candidates[0]!);
    else conflicts.push({ path, candidates });
  }
  const body = { ...payload, files, conflicts };
  const digest = hash(JSON.stringify(body));
  const bundle = { ...body, id: `patch-${digest}`, digest };
  validateBundle(bundle, bundle.id);
  return bundle;
}

function validateBundle(bundle: TeamPatchBundle, expectedId: string): void {
  assertPatchId(expectedId);
  if (!bundle || bundle.format !== 1 || bundle.id !== expectedId || bundle.id !== `patch-${bundle.digest}` || !isAbsolute(bundle.sourceDirectory) ||
    !/^[a-f0-9]{64}$/u.test(bundle.baselineDigest) || !Array.isArray(bundle.taskSnapshots) || !bundle.taskSnapshots.length ||
    !Array.isArray(bundle.files) || !Array.isArray(bundle.conflicts)) throw new Error("Invalid patch bundle");
  const { id: _id, digest, ...body } = bundle;
  if (hash(JSON.stringify(body)) !== digest) throw new Error("Patch digest does not match its content");
  const ids = new Set<string>();
  for (const task of bundle.taskSnapshots) {
    if (typeof task.taskId !== "string" || !task.taskId || ids.has(task.taskId) || !/^[a-f0-9]{64}$/u.test(task.digest)) throw new Error("Invalid patch task identity");
    ids.add(task.taskId);
  }
  let total = 0;
  const records = [...bundle.files, ...bundle.conflicts.flatMap((conflict) => conflict.candidates)];
  if (records.length > 128) throw new Error("Patch has too many file records");
  for (const file of records) {
    assertRelativePath(file.path);
    if (!["added", "modified", "deleted"].includes(file.kind) || !Array.isArray(file.taskIds) || !file.taskIds.length || file.taskIds.some((id: unknown) => typeof id !== "string" || !ids.has(id))) throw new Error("Invalid patch file ownership");
    for (const prefix of ["before", "after"] as const) {
      const text = file[`${prefix}Text`];
      const sha = file[`${prefix}Sha256`];
      const expected = prefix === "before" ? file.kind !== "added" : file.kind !== "deleted";
      if (expected ? typeof text !== "string" || sha !== hash(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) : text !== undefined || sha !== undefined) throw new Error("Invalid patch file content/hash or unsafe display controls");
      if (text !== undefined) { const bytes = Buffer.byteLength(text); if (bytes > MAX_FILE_BYTES) throw new Error("Patch file exceeds its byte limit"); total += bytes; }
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Patch exceeds its total byte limit");
}

function fileDiff(file: TeamPatchFile): string {
  const old = lines(file.beforeText);
  const next = lines(file.afterText);
  const rendered = [`diff --git a/${file.path} b/${file.path}`, `--- ${file.beforeText === undefined ? "/dev/null" : `a/${file.path}`}`, `+++ ${file.afterText === undefined ? "/dev/null" : `b/${file.path}`}`,
    `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`];
  for (const [prefix, entries, text] of [["-", old, file.beforeText], ["+", next, file.afterText]] as const) {
    for (const line of entries) rendered.push(`${prefix}${line}`);
    if (entries.length && !text!.endsWith("\n")) rendered.push("\\ No newline at end of file");
  }
  return rendered.join("\n");
}

function lines(text?: string): string[] { if (!text) return []; const result = text.split("\n"); if (text.endsWith("\n")) result.pop(); return result; }

async function preflight(source: string, files: readonly TeamPatchFile[]): Promise<Map<string, Buffer | undefined>> {
  const originals = new Map<string, Buffer | undefined>();
  const paths = files.map((file) => file.path);
  for (const path of paths) if (paths.some((other) => other !== path && other.startsWith(`${path}/`))) throw new Error("Patch contains overlapping file and directory paths");
  for (const file of files) {
    const target = checkedPath(source, file.path);
    const current = await safeRead(source, target, MAX_FILE_BYTES);
    assertBefore(file, current); originals.set(file.path, current);
    await missingDirectories(source, dirname(target));
  }
  return originals;
}

function assertBefore(file: TeamPatchFile, current?: Buffer): void {
  if (file.beforeSha256 === undefined ? current !== undefined : current === undefined || hash(current) !== file.beforeSha256) throw new Error(`Source changed since the baseline: ${file.path}`);
}

async function safeRead(root: string, path: string, maxBytes: number): Promise<Buffer | undefined> {
  await assertParents(root, path);
  let before;
  try { before = await lstat(path); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maxBytes) throw new Error("Patch file is unsafe or exceeds its byte limit");
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size || stat.nlink > 1) throw new Error("Patch file changed while opening");
    const bytes = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < bytes.length) { const result = await file.read(bytes, position, bytes.length - position, position); if (!result.bytesRead) break; position += result.bytesRead; }
    const after = await file.stat();
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Patch file changed while reading");
    await assertParents(root, path);
    return bytes.subarray(0, position);
  } finally { await file.close(); }
}

async function assertParents(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error("Patch path leaves its root");
  if ((await safeRoot(root)) !== root) throw new Error("Patch root identity changed");
  let cursor = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch parent is not a safe directory"); }
    catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  }
}

async function missingDirectories(root: string, path: string): Promise<string[]> {
  if (!inside(root, path)) throw new Error("Patch directory leaves its root");
  const missing: string[] = [];
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch parent is unsafe"); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; missing.push(cursor); }
  }
  return missing;
}

async function safeRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  for (;;) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch directory is unsafe"); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return realpath(absolute);
}

async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let parent = absolute;
  for (;;) {
    try { await safeRoot(parent); break; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; missing.unshift(parent); parent = dirname(parent); }
  }
  for (const directory of missing) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await safeRoot(directory);
  }
  return safeRoot(absolute);
}

async function durableFile(path: string, content: string | Uint8Array, flag: "wx"): Promise<void> {
  const file = await open(path, flag, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try { directory = await open(path, "r"); await directory.sync(); }
  catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EINVAL", "EISDIR"].some((code) => hasCode(error, code))) throw error; }
  finally { await directory?.close(); }
}

function checkedPath(root: string, path: string): string { assertRelativePath(path); const target = resolve(root, path); if (!inside(root, target)) throw new Error("Patch path leaves its root"); return target; }
function assertRelativePath(path: string): void {
  if (typeof path !== "string" || !path || isAbsolute(path) || /[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error("Unsafe or nonportable patch path");
}
function assertPatchId(id: string): void { if (!/^patch-[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid patch id"); }
function inside(root: string, path: string): boolean { const child = relative(root, path); return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)); }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
