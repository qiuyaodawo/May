import { acquireFileLock, hasErrorCode } from "@sortedyuan/may/storage";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TaskWorkspaceManager } from "@sortedyuan/coordination";
import {
  assertPatchId,
  bundleFrom,
  MAX_BUNDLE_BYTES,
  MAX_FILE_BYTES,
  validateBundle,
  type TeamPatchBundle,
  type TeamPatchFile,
} from "./team-patch-bundle.js";
import {
  assertParents,
  checkedPath,
  durableFile,
  hash,
  inside,
  missingDirectories,
  privateDirectory,
  safeRead,
  safeRoot,
  syncDirectory,
} from "./team-patch-files.js";

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
export async function createTeamPatch(options: {
  readonly directory: string;
  readonly workspaces: TaskWorkspaceManager;
  readonly taskIds: readonly string[];
}): Promise<TeamPatchBundle> {
  const bundle = bundleFrom(await options.workspaces.snapshotPatch(options.taskIds));
  if (inside(bundle.sourceDirectory, resolve(options.directory)))
    throw new Error("Patch storage must be outside the source workspace");
  const patches = await privateDirectory(join(resolve(options.directory), "patches"));
  const path = join(patches, `${bundle.id}.json`);
  try {
    await durableFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "wx");
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    if (!isDeepStrictEqual(await readTeamPatch(options.directory, bundle.id), bundle))
      throw new Error("Patch id already exists with different content");
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
  if (options.confirmDigest !== bundle.digest)
    throw new Error("Apply requires the exact digest from the reviewed patch");
  if (bundle.conflicts.length > 0)
    throw new Error("Patch has conflicting task results; choose a non-conflicting task set");
  const existing = await readTeamPatchApplication(options.directory, bundle.id);
  if (existing) return { ...existing, ...(existing.status === "applied" ? { alreadyApplied: true } : {}) };
  const source = await safeRoot(bundle.sourceDirectory);
  if (source !== bundle.sourceDirectory) throw new Error("Patch source identity changed");
  const taskIds = bundle.taskSnapshots.map((task) => task.taskId);
  const checkTasks = async () => {
    const current = bundleFrom(await options.workspaces.snapshotPatch(taskIds));
    if (current.digest !== bundle.digest)
      throw new Error("Task or baseline snapshot changed since review; create a new patch");
  };
  await checkTasks();
  await preflight(source, bundle.files);
  // One cooperative lock per canonical source, independent of team/data directories.
  const lockDirectory = join(homedir(), ".may", "maybecode", "apply-locks");
  if (inside(source, resolve(lockDirectory)))
    throw new Error("Apply lock directory must be outside the source workspace");
  const locks = await privateDirectory(lockDirectory);
  if (inside(source, locks)) throw new Error("Apply lock directory must be outside the source workspace");
  const lock = await acquireFileLock(join(locks, `${hash(source)}.lock`));
  let journal: FileHandle | undefined;
  let sequence = 0;
  const appliedPaths: string[] = [];
  let begun = false;
  const applicationDirectory = join(resolve(options.directory), "patches", "applications", bundle.id);
  const journalPath = join(applicationDirectory, "apply.jsonl");
  const append = async (record: Omit<ApplyRecord, "revision" | "digest">) => {
    await journal!.writeFile(`${JSON.stringify({ ...record, revision: sequence + 1, digest: bundle.digest })}\n`);
    await journal!.sync();
    sequence++;
  };
  try {
    // Closing the race with another cooperative applier is separate from task/source validation.
    const prior = await readTeamPatchApplication(options.directory, bundle.id);
    if (prior) return { ...prior, ...(prior.status === "applied" ? { alreadyApplied: true } : {}) };
    await checkTasks();
    const originals = await preflight(source, bundle.files);
    await privateDirectory(applicationDirectory);
    journal = await open(journalPath, "ax", 0o600);
    await append({ type: "started" });
    begun = true;
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
      const temporary =
        file.afterText === undefined
          ? undefined
          : join(dirname(target), `.maybecode-${bundle.id.slice(6, 18)}-${randomUUID()}.tmp`);
      await append({
        type: "intent",
        path: file.path,
        ...(before ? { backup: `${hash(file.path)}.txt` } : {}),
        ...(temporary ? { temporary: relative(source, temporary).split(sep).join("/") } : {}),
        newDirectories: missing.map((path) => relative(source, path).split(sep).join("/")),
      });
      for (const path of missing) {
        await assertParents(source, path);
        await mkdir(path);
      }
      if (temporary) {
        await assertParents(source, target);
        const mode = before === undefined ? 0o600 : (await lstat(target)).mode & 0o777;
        const staged = await open(temporary, "wx", mode);
        try {
          await staged.writeFile(file.afterText!, "utf8");
          await staged.sync();
        } finally {
          await staged.close();
        }
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
        try {
          await final.sync();
        } finally {
          await final.close();
        }
      }
      await syncDirectory(dirname(target));
      const after = await safeRead(source, target, MAX_FILE_BYTES);
      if (
        file.afterSha256 === undefined ? after !== undefined : after === undefined || hash(after) !== file.afterSha256
      )
        throw new Error("Source changed before the patch result was acknowledged");
      await append({ type: "applied", path: file.path });
      appliedPaths.push(file.path);
      options.onProgress?.({ type: "file.applied", path: file.path });
    }
    await append({ type: "completed" });
    return {
      status: "applied",
      patchId: bundle.id,
      digest: bundle.digest,
      appliedPaths,
      uncertainPaths: [],
      journalPath,
    };
  } catch (error) {
    if (!begun) throw error;
    // An error after the durable start is conservatively unknown, even when no effect was observed.
    // If the unknown record cannot be written, the journal ends after its start record, which readers report as unknown.
    try {
      await append({ type: "unknown" });
    } catch (appendError) {
      throw new AggregateError(
        [error, appendError],
        "Patch application failed and its unknown outcome could not be recorded",
      );
    }
    return {
      status: "unknown",
      patchId: bundle.id,
      digest: bundle.digest,
      appliedPaths,
      uncertainPaths: bundle.files.map((file) => file.path).filter((path) => !appliedPaths.includes(path)),
      journalPath,
      detail: error instanceof Error ? error.message : "Patch application outcome is unknown",
    };
  } finally {
    try {
      await journal?.close();
    } finally {
      await lock.release();
    }
  }
}

/** Incomplete/partial records are unknown evidence, never an invitation to resume source writes. */
export async function readTeamPatchApplication(
  directory: string,
  patchId: string,
): Promise<TeamPatchApplication | undefined> {
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
      if (
        entry.revision !== ++revision ||
        entry.digest !== bundle.digest ||
        !["started", "intent", "applied", "completed", "unknown"].includes(entry.type) ||
        (revision === 1 ? entry.type !== "started" : entry.type === "started") ||
        ["completed", "unknown"].includes(last ?? "")
      )
        throw new Error("Invalid application sequence");
      if (entry.type === "intent") {
        if (
          !bundle.files.some((file) => file.path === entry.path) ||
          pending.has(entry.path!) ||
          appliedPaths.includes(entry.path!)
        )
          throw new Error("Invalid application intent");
        pending.add(entry.path!);
      }
      if (entry.type === "applied") {
        if (!pending.delete(entry.path!)) throw new Error("Application result has no intent");
        appliedPaths.push(entry.path!);
      }
      if (entry.type === "completed") {
        if (pending.size || appliedPaths.length !== bundle.files.length)
          throw new Error("Application completed before all files");
        completed = true;
      }
      last = entry.type;
    } catch {
      valid = false;
      break;
    }
  }
  const status = valid && completed ? "applied" : "unknown";
  return {
    status,
    patchId,
    digest: bundle.digest,
    appliedPaths,
    uncertainPaths:
      status === "applied" ? [] : bundle.files.map((file) => file.path).filter((path) => !appliedPaths.includes(path)),
    journalPath,
    ...(status === "unknown"
      ? { detail: "Incomplete or unknown application evidence; source writes were not replayed" }
      : {}),
  };
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
    if (entry.revision !== ++revision || entry.digest !== bundle.digest)
      throw new Error("Invalid application evidence");
    if (entry.temporary === undefined) continue;
    const change = bundle.files.find((file) => file.path === entry.path);
    if (entry.type !== "intent" || change?.afterText === undefined) throw new Error("Staging file has no patch intent");
    const path = checkedPath(source, entry.temporary);
    if (
      dirname(path) !== dirname(checkedPath(source, change.path)) ||
      !new RegExp(`^\\.maybecode-${bundle.id.slice(6, 18)}-[a-f0-9-]{36}\\.tmp$`, "u").test(basename(path))
    )
      throw new Error("Unsafe staging path");
    if ((await safeRead(source, path, MAX_FILE_BYTES)) !== undefined) paths.add(path);
  }
  // Validate the entire list first. The caller guarantees no competing writers.
  for (const path of paths) {
    await assertParents(source, path);
    await unlink(path);
  }
  return [...paths];
}

async function preflight(source: string, files: readonly TeamPatchFile[]): Promise<Map<string, Buffer | undefined>> {
  const originals = new Map<string, Buffer | undefined>();
  const paths = files.map((file) => file.path);
  for (const path of paths)
    if (paths.some((other) => other !== path && other.startsWith(`${path}/`)))
      throw new Error("Patch contains overlapping file and directory paths");
  for (const file of files) {
    const target = checkedPath(source, file.path);
    const current = await safeRead(source, target, MAX_FILE_BYTES);
    assertBefore(file, current);
    originals.set(file.path, current);
    await missingDirectories(source, dirname(target));
  }
  return originals;
}

function assertBefore(file: TeamPatchFile, current?: Buffer): void {
  if (
    file.beforeSha256 === undefined
      ? current !== undefined
      : current === undefined || hash(current) !== file.beforeSha256
  )
    throw new Error(`Source changed since the baseline: ${file.path}`);
}
