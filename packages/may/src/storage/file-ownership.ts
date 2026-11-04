import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { tryLock, unlock } from "fs-native-extensions";
import writeFileAtomic from "write-file-atomic";
import { hasErrorCode } from "./errors.js";
import { withFileAccess } from "./file-access.js";

export interface FileLock {
  readonly path: string;
  /** Reject when the lock path no longer refers to the locked file, for example after a rename. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Process-exclusive writer lock backed by an OS file lock. The OS releases it when the
 * owner exits, so a lock file left by a crashed process never blocks the next owner.
 * Owner metadata in `<path>.owner` is informational and only used in conflict errors.
 */
export async function acquireFileLock(path: string): Promise<FileLock> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  let locked = false;
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Lock path is not a regular file: ${path}`);
    locked = tryLock(file.fd, 0, 0, { shared: false });
    if (!locked) {
      throw Object.assign(new Error(`Lock is held by another owner: ${path}${await describeOwner(path)}`), { code: "ELOCKED" });
    }
    await writeFileAtomic(`${path}.owner`, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    try { if (locked) unlock(file.fd, 0, 0); } finally { await file.close(); }
    throw error;
  }
  let releasing: Promise<void> | undefined;
  return {
    path,
    async assertHeld() {
      if (releasing !== undefined) throw new Error(`Lock has been released: ${path}`);
      const owned = await file.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
        throw new Error(`Lock ownership changed: ${path}`);
      }
    },
    release: () => releasing ??= (async () => {
      try { unlock(file.fd, 0, 0); } finally { await file.close(); }
    })(),
  };
}

export interface FileLockSync {
  readonly path: string;
  release(): void;
}

/** Synchronous form of acquireFileLock for hosts built on synchronous storage such as node:sqlite. */
export function acquireFileLockSync(path: string): FileLockSync {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const file = openSync(path, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  let locked = false;
  try {
    if (!fstatSync(file).isFile()) throw new Error(`Lock path is not a regular file: ${path}`);
    locked = tryLock(file, 0, 0, { shared: false });
    if (!locked) {
      throw Object.assign(new Error(`Lock is held by another owner: ${path}${describeOwnerSync(path)}`), { code: "ELOCKED" });
    }
    writeFileAtomic.sync(`${path}.owner`, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    try { if (locked) unlock(file, 0, 0); } finally { closeSync(file); }
    throw error;
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try { unlock(file, 0, 0); } finally { closeSync(file); }
    },
  };
}

function describeOwnerSync(path: string): string {
  try { return ` (owner: ${readFileSync(`${path}.owner`, "utf8").slice(0, 512)})`; }
  catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

async function describeOwner(path: string): Promise<string> {
  let text: string;
  try { text = await readFile(`${path}.owner`, "utf8"); }
  catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
  return ` (owner: ${text.slice(0, 512)})`;
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not provide POSIX directory fsync through Node.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Atomically replace a file's contents and make the rename durable. */
export async function writeFileDurable(path: string, contents: string | Buffer, mode = 0o600): Promise<void> {
  await writeFileAtomic(path, contents, { mode });
  await syncDirectory(dirname(path));
}

/** Caller owns the writer lock. A failure after rename has an unknown durability outcome. */
export async function replaceJournalFile(path: string, contents: string): Promise<FileHandle> {
  await withFileAccess(path, "exclusive", () => writeFileAtomic(path, contents, { mode: 0o600 }));
  await syncDirectory(dirname(path));
  return open(path, "a+", 0o600);
}
