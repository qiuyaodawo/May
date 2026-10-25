import { constants } from "node:fs";
import { acquireFileLock, releaseFileLock, replaceJournalFile, withFileAccess } from "@sortedyuan/file-storage";
import { lstat, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AsyncStateSerializer } from "@sortedyuan/application";
import type { CoordinationJournal, CoordinationSnapshot, CoordinationStore } from "./types.js";
import { copy, name, positive, validateSnapshot } from "./validation.js";

/** Local single-writer JSONL journal. Stale locks are never stolen automatically. */
export class FileCoordinationStore implements CoordinationStore {
  readonly directory: string;
  constructor(directory: string, readonly maxJournalBytes = 67_108_864) {
    this.directory = resolve(directory);
    positive(maxJournalBytes, "maxJournalBytes");
  }

  /** 查询保持日志内容不变；首次访问会创建协调文件，读取时持有共享访问锁。 */
  async inspect(id: string): Promise<CoordinationSnapshot | undefined> {
    name(id, "coordination id");
    const path = join(this.directory, `${Buffer.from(id).toString("base64url")}.jsonl`);
    try {
      await lstat(path);
      return await withFileAccess(path, "shared", async () => {
        if ((await lstat(path)).isSymbolicLink()) throw new Error("Coordination journal must not be a symbolic link");
        const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > this.maxJournalBytes) throw new Error("Coordination journal exceeds maxJournalBytes");
          const bytes = await file.readFile();
          if (bytes.length > this.maxJournalBytes) throw new Error("Coordination journal exceeds maxJournalBytes");
          let current: CoordinationSnapshot | undefined;
          for (const line of bytes.subarray(0, bytes.lastIndexOf(10) + 1).toString("utf8").split("\n").slice(0, -1)) {
            const record = JSON.parse(line) as CoordinationSnapshot | { checkpoint: CoordinationSnapshot };
            const next = "checkpoint" in record ? record.checkpoint : record;
            const checkpoint = "checkpoint" in record && current === undefined; validateSnapshot(next, id);
            if (!checkpoint && next.revision !== (current?.revision ?? 0) + 1) throw new Error("Invalid coordination journal sequence");
            current = next;
          }
          return current === undefined ? undefined : copy(current);
        } finally { await file.close(); }
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async acquire(id: string): Promise<CoordinationJournal> {
    name(id, "coordination id");
    await mkdir(this.directory, { recursive: true });
    const filename = Buffer.from(id).toString("base64url");
    const lockPath = join(this.directory, `${filename}.lock`);
    const lock = await acquireFileLock(lockPath);
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, id })); await lock.sync();
      const path = join(this.directory, `${filename}.jsonl`);
      return await withFileAccess(path, "exclusive", async () => {
        try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Coordination journal must not be a symbolic link"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
        if ((await file.stat()).size > this.maxJournalBytes) throw new Error("Coordination journal exceeds maxJournalBytes");
        const bytes = await readFile(path);
        const committedLength = bytes.length === 0 || bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1;
        // 仅修复尚未结束的末尾记录，完整记录损坏时立即失败。
        const lines = bytes.subarray(0, committedLength).toString("utf8").split("\n");
        let current: CoordinationSnapshot | undefined;
        for (const line of lines.slice(0, -1)) {
          const record = JSON.parse(line) as CoordinationSnapshot | { checkpoint: CoordinationSnapshot };
          const next = "checkpoint" in record ? record.checkpoint : record;
          const checkpoint = "checkpoint" in record && current === undefined;
          validateSnapshot(next, id);
          if (!checkpoint && next.revision !== (current?.revision ?? 0) + 1) throw new Error("Invalid coordination journal sequence");
          current = next;
        }
        if (committedLength !== bytes.length) {
          const repair = await open(path, "r+");
          try { await repair.truncate(committedLength); await repair.sync(); }
          finally { await repair.close(); }
        }
        return journal(file, path, lock, lockPath, id, current, committedLength, this.maxJournalBytes);
      });
    } catch (error) {
      await file?.close().catch(() => undefined);
      await releaseFileLock(lock, lockPath);
      throw error;
    }
  }
}

function journal(file: FileHandle, path: string, lock: FileHandle, lockPath: string, id: string,
  initial: CoordinationSnapshot | undefined, initialSize: number, maxBytes: number): CoordinationJournal {
  const serial = new AsyncStateSerializer();
  let current = initial;
  let size = initialSize;
  let failed = false;
  let closing: Promise<void> | undefined;
  return {
    read: () => serial.run(() => { if (failed) throw new Error("Journal write outcome is unknown; reopen before continuing"); return current === undefined ? undefined : copy(current); }),
    commit: (snapshot, expectedRevision) => {
      const next = copy(snapshot);
      return serial.run(async () => {
        if (failed) throw new Error("Journal write outcome is unknown; reopen before continuing");
        validateSnapshot(next, id);
        if ((current?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error("Coordination revision conflict");
        const line = `${JSON.stringify(next)}\n`;
        const length = Buffer.byteLength(line);
        const compact = size + length > maxBytes;
        const checkpoint = `${JSON.stringify({ checkpoint: next })}\n`;
        if (length > maxBytes || compact && Buffer.byteLength(checkpoint) > maxBytes) throw new Error("Coordination snapshot exceeds maxJournalBytes");
        try {
          if (compact) {
            const previous = file;
            await previous.close();
            file = await replaceJournalFile(path, checkpoint);
          } else { await withFileAccess(path, "exclusive", async () => { await file.writeFile(line, "utf8"); await file.sync(); }); }
        }
        catch (error) { failed = true; throw error; }
        current = next; size = compact ? Buffer.byteLength(checkpoint) : size + length;
      });
    },
    close: () => closing ??= (async () => {
      await serial.close();
      // Never release ownership before all writes and the file handle are closed.
      try { await file.close(); } finally { await releaseFileLock(lock, lockPath); }
    })(),
  };
}
