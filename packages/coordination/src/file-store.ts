import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AsyncStateSerializer } from "@may/application";
import type { CoordinationJournal, CoordinationSnapshot, CoordinationStore } from "./types.js";
import { copy, name, positive, validateSnapshot } from "./validation.js";

/** Local single-writer JSONL journal. Stale locks are never stolen automatically. */
export class FileCoordinationStore implements CoordinationStore {
  readonly directory: string;
  constructor(directory: string, readonly maxJournalBytes = 67_108_864) {
    this.directory = resolve(directory);
    positive(maxJournalBytes, "maxJournalBytes");
  }

  async acquire(id: string): Promise<CoordinationJournal> {
    name(id, "coordination id");
    await mkdir(this.directory, { recursive: true });
    const filename = Buffer.from(id).toString("base64url");
    const lockPath = join(this.directory, `${filename}.lock`);
    const lock = await open(lockPath, "wx");
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, id })); await lock.sync();
      const path = join(this.directory, `${filename}.jsonl`);
      file = await open(path, "a+");
      if ((await file.stat()).size > this.maxJournalBytes) throw new Error("Coordination journal exceeds maxJournalBytes");
      const bytes = await readFile(path);
      const committedLength = bytes.length === 0 || bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1;
      // Only the unterminated final record can be discarded. Complete corruption fails closed.
      const lines = bytes.subarray(0, committedLength).toString("utf8").split("\n");
      let current: CoordinationSnapshot | undefined;
      for (const line of lines.slice(0, -1)) {
        const next = JSON.parse(line) as CoordinationSnapshot;
        validateSnapshot(next, id);
        if (next.revision !== (current?.revision ?? 0) + 1) throw new Error("Invalid coordination journal sequence");
        current = next;
      }
      if (committedLength !== bytes.length) {
        // Windows append-only handles cannot truncate; repair under the same writer lock.
        const repair = await open(path, "r+");
        try { await repair.truncate(committedLength); await repair.sync(); }
        finally { await repair.close(); }
      }
      return journal(file, lock, lockPath, id, current, committedLength, this.maxJournalBytes);
    } catch (error) {
      await file?.close().catch(() => undefined);
      await lock.close(); await unlink(lockPath);
      throw error;
    }
  }
}

function journal(file: FileHandle, lock: FileHandle, lockPath: string, id: string,
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
        if (size + length > maxBytes) throw new Error("Coordination journal exceeds maxJournalBytes");
        try { await file.writeFile(line, "utf8"); await file.sync(); }
        catch (error) { failed = true; throw error; }
        current = next; size += length;
      });
    },
    close: () => closing ??= (async () => {
      await serial.close();
      // Never release ownership before all writes and the file handle are closed.
      await file.close(); await lock.close(); await unlink(lockPath);
    })(),
  };
}
