import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { hostname } from "node:os";

/** Local cooperative ownership. Recovery requires an explicitly quiescent host. */
export async function acquireFileLock(path: string): Promise<FileHandle> {
  try { return await open(path, "wx", 0o600); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    throw Object.assign(new Error(`Writer lock exists: ${path}. Stop all hosts using this data, inspect the owner, then use recoverFileLock with the exact lock contents. Never remove a live owner's lock.`, { cause: error }), { code: "EEXIST" });
  }
}

/** The caller must stop all competing open/recovery operations before invoking this. */
export async function recoverFileLock(path: string, options: {
  readonly expectedContents: string;
  readonly confirmHostsStopped: true;
  /** Required for incomplete metadata; confirms independent owner verification. */
  readonly confirmUnknownOwner?: true;
}): Promise<void> {
  if (options.confirmHostsStopped !== true) throw new Error("Lock recovery requires stopped hosts");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error("Unsafe lock file");
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const contents = await file.readFile("utf8");
    if (contents !== options.expectedContents) throw new Error("Lock owner changed");
    let owner: { pid?: number; hostname?: string } | undefined;
    try { owner = JSON.parse(contents) ?? undefined; } catch { /* A crash can precede metadata publication. */ }
    if (owner?.hostname !== undefined && owner.hostname !== hostname()) throw new Error("Cannot verify a remote lock owner");
    if (!Number.isSafeInteger(owner?.pid) || owner!.pid! <= 0) {
      if (options.confirmUnknownOwner !== true) throw new Error("Incomplete lock metadata; independent owner verification is required");
    } else {
      try { process.kill(owner!.pid!, 0); throw new Error("Lock owner is still alive"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
    const current = await lstat(path);
    if (current.ino !== info.ino || current.dev !== info.dev || await readFile(path, "utf8") !== contents) throw new Error("Lock owner changed");
    await unlink(path);
  } finally { await file.close(); }
}

export async function releaseFileLock(file: FileHandle, path: string): Promise<void> {
  try { await file.close(); } finally { await unlink(path); }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not provide POSIX directory fsync through Node.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Caller owns the writer lock. A failure after rename has an unknown durability outcome. */
export async function replaceJournalFile(path: string, contents: string): Promise<FileHandle> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
    return await open(path, "a+", 0o600);
  } finally { await rm(temporary, { force: true }); }
}
