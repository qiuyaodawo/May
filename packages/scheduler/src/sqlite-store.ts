import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { SchedulerStore } from "./types.js";
import { validateId, validateStoredJson } from "./validation.js";

const APPLICATION_ID = 0x4d415953;
const LOCK_APPLICATION_ID = 0x4d41594c;
const SCHEMA_VERSION = 1;
const COLLECTIONS = new Set(["jobs", "executions", "events", "meta"]);
const SCHEMA_SQL = `CREATE TABLE scheduler_records (
  collection TEXT NOT NULL CHECK (collection IN ('jobs', 'executions', 'events', 'meta')),
  id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (collection, id)
) STRICT`;

export class SqliteSchedulerStore implements SchedulerStore {
  readonly #database: DatabaseSync;
  readonly #ownership: DatabaseSync;
  readonly #get: StatementSync;
  readonly #list: StatementSync;
  readonly #put: StatementSync;
  readonly #delete: StatementSync;
  #closed = false;
  #transactionDepth = 0;

  private constructor(database: DatabaseSync, ownership: DatabaseSync) {
    this.#database = database;
    this.#ownership = ownership;
    this.#get = database.prepare("SELECT value FROM scheduler_records WHERE collection = ? AND id = ?");
    this.#list = database.prepare("SELECT value FROM scheduler_records WHERE collection = ? ORDER BY id");
    this.#put = database.prepare("INSERT INTO scheduler_records (collection, id, value) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET value = excluded.value");
    this.#delete = database.prepare("DELETE FROM scheduler_records WHERE collection = ? AND id = ?");
  }

  static open(path: string): SqliteSchedulerStore {
    const canonicalPath = normalizePath(path);
    const ownershipPath = `${canonicalPath}.scheduler-lock.sqlite`;
    validateOwnershipFile(ownershipPath);
    let ownership: DatabaseSync | undefined;
    let database: DatabaseSync | undefined;
    try {
      ownership = new DatabaseSync(ownershipPath, { timeout: 0 });
      try {
        ownership.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        if (isBusy(error)) throw new Error(`Scheduler storage already has an active owner: ${canonicalPath}`, { cause: error });
        throw error;
      }
      validateOwnershipDatabase(ownership);
      database = new DatabaseSync(canonicalPath, { timeout: 0 });
      initializeDatabase(database);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF");
      return new SqliteSchedulerStore(database, ownership);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const connection of [database, ownership]) {
        if (connection === undefined) continue;
        try { connection.close(); } catch (cleanupError) { failures.push(cleanupError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Scheduler storage failed to open and release its resources");
      throw error;
    }
  }

  get<T>(collection: string, id: string): T | undefined {
    this.#assertOpen();
    validateCollection(collection);
    validateId(id);
    const row = this.#get.get(collection, id);
    return row === undefined ? undefined : decode<T>(row.value);
  }

  list<T>(collection: string): T[] {
    this.#assertOpen();
    validateCollection(collection);
    return this.#list.all(collection).map((row) => decode<T>(row.value));
  }

  put(collection: string, id: string, value: unknown): void {
    this.#assertOpen();
    validateCollection(collection);
    validateId(id);
    this.#put.run(collection, id, JSON.stringify(validateStoredJson(value)));
  }

  delete(collection: string, id: string): void {
    this.#assertOpen();
    validateCollection(collection);
    validateId(id);
    this.#delete.run(collection, id);
  }

  transaction<T>(callback: () => T): T {
    this.#assertOpen();
    if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") {
      throw new TypeError("Scheduler storage transactions require a synchronous callback");
    }
    const depth = this.#transactionDepth;
    const savepoint = `scheduler_${depth}`;
    this.#database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = callback();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        throw new TypeError("Scheduler storage transactions cannot return a Promise");
      }
      this.#database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.#database.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Scheduler storage transaction failed to undo its writes");
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#transactionDepth !== 0) throw new Error("Cannot close scheduler storage during a transaction");
    this.#closed = true;
    try { this.#database.close(); } finally { this.#ownership.close(); }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Scheduler storage is closed");
  }
}

function normalizePath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0 || path === ":memory:" || path.includes("\0")) {
    throw new TypeError("Scheduler storage requires a persistent database file path");
  }
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const existing = lstatSync(absolute, { throwIfNoEntry: false });
  const canonical = existing !== undefined
    ? realpathSync.native(absolute)
    : resolve(realpathSync.native(dirname(absolute)), basename(absolute));
  if (existing !== undefined) {
    const info = statSync(canonical);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Scheduler database must be a regular file with one filesystem link");
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function validateOwnershipFile(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Scheduler ownership database must be a regular file with one filesystem link");
  }
}

function validateOwnershipDatabase(database: DatabaseSync): void {
  const applicationId = database.prepare("PRAGMA application_id").get()?.application_id;
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (objects.length !== 0 || !((applicationId === 0 && version === 0) || (applicationId === LOCK_APPLICATION_ID && version === SCHEMA_VERSION))) {
    throw new Error("Unsupported scheduler ownership database");
  }
  database.exec(`PRAGMA application_id = ${LOCK_APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function initializeDatabase(database: DatabaseSync): void {
  const applicationId = database.prepare("PRAGMA application_id").get()?.application_id;
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  const objects = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (applicationId === 0 && version === 0 && objects.length === 0) {
    database.exec(`BEGIN IMMEDIATE; ${SCHEMA_SQL}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
  } else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION || objects.length !== 1 || objects[0]?.name !== "scheduler_records" || objects[0]?.type !== "table" || objects[0]?.sql !== SCHEMA_SQL) {
    throw new Error("Unsupported scheduler database or schema version");
  }
  const integrity = database.prepare("PRAGMA quick_check").all();
  if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") throw new Error("Scheduler database integrity validation failed");
}

function validateCollection(collection: string): void {
  if (!COLLECTIONS.has(collection)) throw new TypeError(`Unknown scheduler storage collection: ${collection}`);
}

function decode<T>(value: unknown): T {
  if (typeof value !== "string") throw new TypeError("Scheduler record must contain JSON text");
  return validateStoredJson(JSON.parse(value) as T);
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6);
}
