import { acquireFileLock, releaseFileLock, replaceJournalFile } from "@may/session/file-store";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncStateSerializer } from "@may/application";

interface Revision { readonly format: 1; readonly revision: number }

/** Internal, exclusive-writer snapshot journal. No recovery operation replays effects. */
export class ResourceJournal<T extends Revision> {
  private readonly serial = new AsyncStateSerializer();
  private failed = false;
  private closing: Promise<void> | undefined;
  private constructor(private file: FileHandle, private readonly path: string, private readonly lock: FileHandle,
    private readonly lockPath: string, private current: T, private size: number,
    private readonly validate: (value: T) => void, private readonly maxBytes: number) {}

  /** Read-only monitoring. Ignore an in-flight tail, never repair or acquire writer ownership. */
  static async inspect<T extends Revision>(path: string, validate: (value: T) => void, maxBytes = 67_108_864): Promise<T | undefined> {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Resource journal must not be a symbolic link");
    const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("Resource journal exceeds its byte limit or is not a file");
      const bytes = await file.readFile();
      if (bytes.length > maxBytes) throw new Error("Resource journal exceeds its byte limit");
      const end = bytes.lastIndexOf(10) + 1;
      let state: T | undefined;
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n").slice(0, -1)) {
        const record = JSON.parse(line) as T | { checkpoint: T };
        const next = "checkpoint" in record ? record.checkpoint : record; validate(next);
        if (!(state === undefined && "checkpoint" in record) && next.revision !== (state?.revision ?? 0) + 1) throw new Error("Invalid resource journal sequence");
        state = next;
      }
      return state;
    } finally { await file.close(); }
  }

  static async open<T extends Revision>(path: string, initial: T, validate: (value: T) => void,
    maxBytes = 67_108_864): Promise<ResourceJournal<T>> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const lock = await acquireFileLock(lockPath);
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Resource journal must not be a symbolic link"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("Resource journal exceeds its byte limit or is not a file");
      const bytes = await file.readFile();
      const committed = bytes.length === 0 || bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1;
      let current = initial;
      validate(current);
      for (const line of bytes.subarray(0, committed).toString("utf8").split("\n").slice(0, -1)) {
        const record = JSON.parse(line) as T | { checkpoint: T };
        const next = "checkpoint" in record ? record.checkpoint : record;
        validate(next);
        if (!(current === initial && "checkpoint" in record) && next.revision !== current.revision + 1) throw new Error("Invalid resource journal sequence");
        current = next;
      }
      if (committed !== bytes.length) {
        const repair = await open(path, "r+");
        try { await repair.truncate(committed); await repair.sync(); } finally { await repair.close(); }
      }
      const journal = new ResourceJournal(file, path, lock, lockPath, current, committed, validate, maxBytes);
      if (committed === 0) await journal.transact((state) => ({ ...state }));
      return journal;
    } catch (error) {
      await file?.close().catch(() => undefined); await releaseFileLock(lock, lockPath); throw error;
    }
  }

  snapshot(): Promise<T> {
    return this.serial.run(() => { this.check(); return structuredClone(this.current); });
  }

  transact(update: (state: T) => T | Promise<T>): Promise<T> {
    return this.serial.run(async () => {
      this.check();
      const next = { ...await update(structuredClone(this.current)), revision: this.current.revision + 1 };
      this.validate(next);
      const line = `${JSON.stringify(next)}\n`;
      const size = Buffer.byteLength(line);
      const compact = this.size + size > this.maxBytes;
      const checkpoint = `${JSON.stringify({ checkpoint: next })}\n`;
      if (size > this.maxBytes || compact && Buffer.byteLength(checkpoint) > this.maxBytes) throw new Error("Resource snapshot exceeds its byte limit");
      try {
        if (compact) {
          const previous = this.file;
          await previous.close();
          this.file = await replaceJournalFile(this.path, checkpoint);
        } else { await this.file.writeFile(line, "utf8"); await this.file.sync(); }
      }
      catch (error) { this.failed = true; throw error; }
      this.current = next; this.size = compact ? Buffer.byteLength(checkpoint) : this.size + size;
      return structuredClone(next);
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.serial.close(); try { await this.file.close(); } finally { await releaseFileLock(this.lock, this.lockPath); }
    })();
  }

  private check(): void {
    if (this.failed) throw new Error("Resource write outcome unknown; close and inspect before continuing");
  }
}

export function resourceId(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new TypeError(`Invalid ${label}`);
}

export function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
}

export function amount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
}
