import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  copyPermissionRule,
  validateRuleIdentifier,
  type PermissionRuleStore,
  type PersistentPermissionRule,
} from "./rules.js";

export interface FilePermissionRuleStoreOptions {
  readonly path: string;
}

export class FilePermissionRuleStore implements PermissionRuleStore {
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;

  private constructor(readonly path: string, private readonly lock: FileHandle) {}

  static async open(options: FilePermissionRuleStoreOptions): Promise<FilePermissionRuleStore> {
    validateRuleIdentifier(options.path, "path");
    const requested = resolve(options.path);
    await mkdir(dirname(requested), { recursive: true });
    const path = join(await realpath(dirname(requested)), basename(requested));
    const lock = await open(`${path}.lock`, "wx", 0o600);
    const store = new FilePermissionRuleStore(path, lock);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
      await lock.sync();
      let exists = true;
      try { await lstat(path); }
      catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        exists = false;
      }
      if (exists) await store.readNow();
      else await store.writeNow([]);
      return store;
    } catch (error) {
      try { await store.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Cannot open or release permission rule store"); }
      throw error;
    }
  }

  async list(scopeId?: string): Promise<readonly PersistentPermissionRule[]> {
    if (scopeId !== undefined) validateRuleIdentifier(scopeId, "scopeId");
    return this.enqueue(async () => Object.freeze((await this.readNow())
      .filter((rule) => scopeId === undefined || rule.scopeId === scopeId)
      .map(copyPermissionRule)));
  }

  async create(rule: PersistentPermissionRule): Promise<void> {
    const next = copyPermissionRule(rule);
    return this.enqueue(async () => {
      const rules = await this.readNow();
      if (rules.some((existing) => existing.id === next.id)) {
        throw new Error(`Permission rule already exists: ${next.id}`);
      }
      await this.writeNow([...rules, next]);
    });
  }

  async revoke(id: string): Promise<boolean> {
    validateRuleIdentifier(id, "id");
    return this.enqueue(async () => {
      const rules = await this.readNow();
      if (!rules.some((rule) => rule.id === id)) return false;
      await this.writeNow(rules.filter((rule) => rule.id !== id));
      return true;
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.tail;
      try {
        const current = await lstat(`${this.path}.lock`);
        const owned = await this.lock.stat();
        if (!current.isFile() || current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev) {
          throw new Error("Permission rule writer lock ownership changed");
        }
        await this.lock.close();
        await unlink(`${this.path}.lock`);
        await syncDirectory(dirname(this.path));
      } catch (error) {
        try { await this.lock.close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Cannot release permission rule writer lock"); }
        throw error;
      }
    })();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error("Permission rule store is closed"));
    const operation = this.tail.then(() => {
      if (this.failure !== undefined) throw this.failure;
      return action();
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readNow(): Promise<readonly PersistentPermissionRule[]> {
    try {
      await this.checkOwnership();
      const before = await lstat(this.path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error("Permission rule store must be a regular file with one link");
      }
      const file = await open(this.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const info = await file.stat();
        if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) {
          throw new Error("Permission rule file changed while opening");
        }
        const contents = await file.readFile("utf8");
        const after = await file.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
          throw new Error("Permission rule file changed while reading");
        }
        return parseRules(JSON.parse(contents));
      } finally { await file.close(); }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async writeNow(rules: readonly PersistentPermissionRule[]): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      await this.checkOwnership();
      const file = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(`${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path);
      created = false;
      await syncDirectory(dirname(this.path));
    } catch (error) {
      this.fail(error);
      if (created) {
        try { await unlink(temporary); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Cannot write or clean permission rule store"); }
      }
      throw error;
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error("Permission rule storage failed", { cause: error });
  }

  private async checkOwnership(): Promise<void> {
    const current = await lstat(`${this.path}.lock`);
    const owned = await this.lock.stat();
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev) {
      throw new Error("Permission rule writer lock ownership changed");
    }
  }
}

function parseRules(value: unknown): readonly PersistentPermissionRule[] {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1 ||
      !("rules" in value) || !Array.isArray(value.rules)) {
    throw new TypeError("Invalid permission rule store format or version");
  }
  const rules = value.rules.map(copyPermissionRule);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate permission rule id: ${rule.id}`);
    ids.add(rule.id);
  }
  return rules;
}

async function syncDirectory(path: string): Promise<void> {
  // Windows 的 Node.js 文件接口不提供目录 fsync。
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
