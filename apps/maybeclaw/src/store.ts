import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { digest, validateId, validateSnapshot, type TaskSnapshot } from "./types.js";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

export class TaskLockedError extends Error {}

export interface TaskJournal {
  read(): TaskSnapshot | undefined;
  write(task: TaskSnapshot): Promise<void>;
  close(): Promise<void>;
}

/** Single writer per task. Status never repairs a live writer's incomplete tail. */
export class FileTaskStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  path(id: string, suffix: string): string {
    validateId(id);
    if (!["jsonl", "lock", "cancel"].includes(suffix)) throw new Error("Invalid task file suffix");
    return join(this.directory, "tasks", `${id}.${suffix}`);
  }

  async inspect(id: string): Promise<TaskSnapshot | undefined> {
    let file: FileHandle;
    try { file = await open(this.path(id, "jsonl"), "r"); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    try { return parse(await boundedRead(file), id).current; }
    finally { await file.close(); }
  }

  async list(): Promise<readonly TaskSnapshot[]> {
    let names: string[];
    try { names = await readdir(join(this.directory, "tasks")); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const tasks: TaskSnapshot[] = [];
    for (const name of names.filter((n) => /^[a-f0-9]{64}\.jsonl$/u.test(n))) {
      const task = await this.inspect(name.slice(0, -6));
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async hasCancel(id: string): Promise<boolean> {
    try { const file = await open(this.path(id, "cancel"), "r"); await file.close(); return true; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }

  async requestCancel(id: string): Promise<void> {
    // Presence is the monotonic cancellation intent. There is no partially parsed payload.
    const file = await open(this.path(id, "cancel"), "a", 0o600);
    try { await file.sync(); } finally { await file.close(); }
  }

  async owner(id: string): Promise<unknown> {
    try {
      const file = await open(this.path(id, "lock"), "r");
      try { return JSON.parse((await boundedRead(file, 4096)).toString("utf8")); }
      finally { await file.close(); }
    } catch (error) { if (isMissing(error)) return null; return { status: "unreadable-lock", path: this.path(id, "lock") }; }
  }

  async acquire(id: string): Promise<TaskJournal> {
    validateId(id);
    await mkdir(join(this.directory, "tasks"), { recursive: true, mode: 0o700 });
    const lockPath = this.path(id, "lock");
    let lock: FileHandle;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (isCode(error, "EEXIST")) throw new TaskLockedError(`Task is locked. Inspect status; never remove a live owner's lock: ${lockPath}`);
      throw error;
    }
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now() }));
      await lock.sync();
      file = await open(this.path(id, "jsonl"), "a+", 0o600);
      const bytes = await boundedRead(file);
      let { current, length } = parse(bytes, id);
      if (length !== bytes.length) {
        const repair = await open(this.path(id, "jsonl"), "r+");
        try { await repair.truncate(length); await repair.sync(); }
        finally { await repair.close(); }
      }
      const handle = file;
      let closed = false;
      let failed = false;
      let tail: Promise<void> = Promise.resolve();
      let closing: Promise<void> | undefined;
      return {
        read: () => { if (closed || failed) throw new Error("Task journal unavailable"); return structuredClone(current); },
        write: (task) => {
          const snapshot = structuredClone(task);
          if (closed) return Promise.reject(new Error("Task journal closed"));
          const next = tail.then(async () => {
            if (failed) throw new Error("Task write outcome unknown; reopen before continuing");
            validateSnapshot(snapshot, id);
            checkNext(current, snapshot);
            const record = `${JSON.stringify(snapshot)}\n`;
            if (length + Buffer.byteLength(record) > MAX_JOURNAL_BYTES) throw new Error("Task journal size limit exceeded");
            try { await handle.writeFile(record); await handle.sync(); }
            catch (error) { failed = true; throw error; }
            current = snapshot; length += Buffer.byteLength(record);
          });
          tail = next.catch(() => undefined);
          return next;
        },
        close: () => closing ??= (async () => {
          closed = true; await tail;
          try { await handle.close(); }
          finally { await lock.close(); await unlink(lockPath); }
        })(),
      };
    } catch (error) {
      await file?.close(); await lock.close(); await unlink(lockPath); throw error;
    }
  }
}

async function boundedRead(file: FileHandle, max = MAX_JOURNAL_BYTES): Promise<Buffer> {
  const info = await file.stat();
  if (!info.isFile() || info.size > max) throw new Error("File exceeds size limit or is not regular");
  const value = await file.readFile();
  if (value.length > max) throw new Error("File exceeds size limit");
  return value;
}

function parse(bytes: Buffer, id: string): { current?: TaskSnapshot; length: number } {
  const length = bytes.lastIndexOf(10) + 1;
  let current: TaskSnapshot | undefined;
  for (const line of bytes.subarray(0, length).toString("utf8").split("\n").slice(0, -1)) {
    const next = JSON.parse(line) as TaskSnapshot;
    validateSnapshot(next, id); checkNext(current, next); current = next;
  }
  return { ...(current ? { current } : {}), length };
}

function checkNext(current: TaskSnapshot | undefined, next: TaskSnapshot): void {
  if (next.revision !== (current?.revision ?? 0) + 1) throw new Error("Invalid task journal sequence");
  if (!current) { if (next.status !== "queued") throw new Error("First task state must be queued"); return; }
  if (next.createdAt !== current.createdAt || next.updatedAt < current.updatedAt || digest(next.spec) !== digest(current.spec)) throw new Error("Task identity changed");
  const allowed: Record<TaskSnapshot["status"], readonly TaskSnapshot["status"][]> = {
    queued: ["running", "cancelled", "blocked"], running: ["queued", "completed", "failed", "cancelled", "blocked"],
    blocked: ["completed", "failed", "cancelled", "blocked"], completed: [], failed: [], cancelled: [],
  };
  if (!allowed[current.status].includes(next.status)) throw new Error("Invalid task state transition");
}

export function isMissing(error: unknown): boolean { return isCode(error, "ENOENT"); }
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
