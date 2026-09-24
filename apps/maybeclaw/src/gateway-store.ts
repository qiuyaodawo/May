import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x4d434c57;

export class GatewayStore {
  readonly directory: string;
  readonly path: string;
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  private constructor(directory: string, private readonly database: DatabaseSync,
    private readonly lock: number, private readonly lockToken: string) {
    this.directory = directory;
    this.path = join(directory, "gateway.sqlite");
  }

  static open(directory: string): GatewayStore {
    const resolved = resolve(directory);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const lockPath = join(resolved, "host.lock");
    const lock = openSync(lockPath, "wx", 0o600);
    const token = randomUUID();
    let database: DatabaseSync | undefined;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now(), token, format: "gateway-v1" }));
      fsyncSync(lock);
      const path = join(resolved, "gateway.sqlite");
      if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      const applicationId = Number(database.prepare("PRAGMA application_id").get()!.application_id);
      const version = Number(database.prepare("PRAGMA user_version").get()!.user_version);
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) throw new Error("Database belongs to another application");
      if (version > SCHEMA_VERSION) throw new Error("Gateway database requires a newer MaybeClaw version");
      if (version !== 0 && applicationId !== APPLICATION_ID) throw new Error("Invalid Gateway database identity");
      database.exec("PRAGMA journal_mode = WAL;");
      const store = new GatewayStore(resolved, database, lock, token);
      if (version === 0) store.transaction(() => {
        database!.exec(`CREATE TABLE records (
          collection TEXT NOT NULL,
          record_id TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          PRIMARY KEY(collection, record_id)
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};`);
      });
      database.prepare("SELECT collection, record_id, payload FROM records LIMIT 0").all();
      return store;
    } catch (error) {
      database?.close();
      closeSync(lock);
      unlinkSync(lockPath);
      throw error;
    }
  }

  get<T>(collection: string, id: string): T | undefined {
    this.assertOpen();
    validateCollection(collection);
    validateKey(id);
    const row = this.database.prepare("SELECT payload FROM records WHERE collection = ? AND record_id = ?").get(collection, id);
    return row === undefined ? undefined : JSON.parse(String(row.payload)) as T;
  }

  list<T>(collection: string): T[] {
    this.assertOpen();
    validateCollection(collection);
    return this.database.prepare("SELECT payload FROM records WHERE collection = ? ORDER BY rowid").all(collection)
      .map((row) => JSON.parse(String(row.payload)) as T);
  }

  entries<T>(collection: string): { id: string; value: T }[] {
    this.assertOpen();
    validateCollection(collection);
    return this.database.prepare("SELECT record_id, payload FROM records WHERE collection = ? ORDER BY rowid").all(collection)
      .map((row) => ({ id: String(row.record_id), value: JSON.parse(String(row.payload)) as T }));
  }

  put(collection: string, id: string, value: unknown): void {
    this.assertOpen();
    validateCollection(collection);
    validateKey(id);
    const payload = JSON.stringify(value);
    if (payload === undefined) throw new Error("Gateway records require JSON values");
    this.database.prepare("INSERT INTO records(collection, record_id, payload) VALUES (?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET payload = excluded.payload")
      .run(collection, id, payload);
  }

  delete(collection: string, id: string): void {
    this.assertOpen();
    validateCollection(collection);
    validateKey(id);
    this.database.prepare("DELETE FROM records WHERE collection = ? AND record_id = ?").run(collection, id);
  }

  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (fn.constructor.name === "AsyncFunction") throw new Error("Gateway transactions require a synchronous callback");
    const outer = this.transactionDepth === 0;
    const savepoint = `gateway_${++this.savepointSequence}`;
    this.database.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = fn();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
        throw new Error("Gateway transactions cannot return a Promise");
      }
      this.database.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.database.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionDepth !== 0) throw new Error("Cannot close a Gateway store inside a transaction");
    this.database.close();
    this.closed = true;
    closeSync(this.lock);
    const lockPath = join(this.directory, "host.lock");
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (owner.token !== this.lockToken) throw new Error("Gateway host lock ownership changed");
    unlinkSync(lockPath);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Gateway store is closed");
  }
}

function validateCollection(collection: string): void {
  if (typeof collection !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(collection)) throw new Error("Invalid Gateway collection name");
}

function validateKey(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error("Invalid Gateway record ID");
}
