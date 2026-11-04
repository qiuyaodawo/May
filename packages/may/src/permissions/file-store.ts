import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AsyncStateSerializer } from "../core/index.js";
import { acquireFileLock, hasErrorCode, writeFileDurable, type FileLock } from "../storage/index.js";
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
  private readonly serial = new AsyncStateSerializer();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;

  private constructor(readonly path: string, private readonly lock: FileLock) {}

  static async open(options: FilePermissionRuleStoreOptions): Promise<FilePermissionRuleStore> {
    validateRuleIdentifier(options.path, "path");
    const requested = resolve(options.path);
    await mkdir(dirname(requested), { recursive: true });
    const path = join(await realpath(dirname(requested)), basename(requested));
    const lock = await acquireFileLock(`${path}.lock`);
    const store = new FilePermissionRuleStore(path, lock);
    try {
      let exists = true;
      try { await lstat(path); }
      catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
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
      try {
        await this.serial.close();
        await this.lock.assertHeld();
      } finally { await this.lock.release(); }
    })();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error("Permission rule store is closed"));
    return this.serial.run(() => {
      if (this.failure !== undefined) throw this.failure;
      return action();
    });
  }

  private async readNow(): Promise<readonly PersistentPermissionRule[]> {
    try {
      await this.lock.assertHeld();
      const before = await lstat(this.path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error("Permission rule store must be a regular file with one link");
      }
      const file = await open(this.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const info = await file.stat({ bigint: true });
        if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) {
          throw new Error("Permission rule file changed while opening");
        }
        const contents = await file.readFile("utf8");
        const after = await file.stat({ bigint: true });
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) {
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
    try {
      await this.lock.assertHeld();
      await writeFileDurable(this.path, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error("Permission rule storage failed", { cause: error });
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
