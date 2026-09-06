import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MayError } from "@may/core";

/** Secrets are opaque to the host. Implementations must not log their values. */
export interface McpCredentialStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Serializes login/refresh/logout for one credential identity, across processes if durable. */
  exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class McpCredentialStoreError extends MayError {
  constructor(message = "MCP credential vault is unavailable; unlock the OS keyring or provide a secure credential store") {
    super("MCP_CREDENTIAL_STORE_UNAVAILABLE", message);
  }
}

/** For headless integrations/tests that deliberately want process-lifetime credentials. */
export class InMemoryMcpCredentialStore implements McpCredentialStore {
  private readonly values = new Map<string, unknown>();
  private readonly locks = new Map<string, Promise<unknown>>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
}

export interface McpVaultKeyring {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
}

/** AES-256-GCM records; only their 32-byte master key lives in the OS keyring. */
export class KeyringMcpCredentialStore implements McpCredentialStore {
  readonly directory: string;
  private key: Promise<Buffer> | undefined;
  constructor(directory: string, private readonly keyring?: McpVaultKeyring) {
    this.directory = resolve(directory);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const path = this.path(key);
    try {
      const info = await stat(path);
      if (info.size > 2 * 1024 * 1024) throw new McpCredentialStoreError();
      const record = JSON.parse(await readFile(path, "utf8")) as {
        version: number; nonce: string; tag: string; ciphertext: string;
      };
      if (record.version !== 1) throw new McpCredentialStoreError();
      const decipher = createDecipheriv("aes-256-gcm", await this.masterKey(false), Buffer.from(record.nonce, "base64"));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final(),
      ]);
      try { return JSON.parse(plain.toString("utf8")) as T; }
      finally { plain.fill(0); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw new McpCredentialStoreError();
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    let temporary: string | undefined;
    try {
      const plain = Buffer.from(JSON.stringify(value));
      if (plain.length > 1024 * 1024) throw new McpCredentialStoreError("MCP credential record is too large");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.masterKey(true), nonce);
      cipher.setAAD(Buffer.from(key));
      let ciphertext: Buffer;
      try { ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]); }
      finally { plain.fill(0); }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      temporary = `${this.path(key)}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({
          version: 1, nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
        }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path(key));
    } catch { throw new McpCredentialStoreError(); }
    finally { if (temporary !== undefined) await unlink(temporary).catch(() => {}); }
  }

  async delete(key: string): Promise<void> {
    try { await unlink(this.path(key)); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw new McpCredentialStoreError(); }
  }

  async exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${digest(key)}.lock`);
    const deadline = Date.now() + 10_000;
    let file;
    while (file === undefined) {
      signal?.throwIfAborted();
      try { file = await open(path, "wx", 0o600); }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw new McpCredentialStoreError();
        if (Date.now() >= deadline) {
          throw new McpCredentialStoreError("MCP credentials are locked by another operation; if it crashed, verify its PID has exited before removing the vault .lock file");
        }
        await delay(50, undefined, signal === undefined ? {} : { signal });
      }
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return await work();
    } finally {
      await file.close();
      await unlink(path);
    }
  }

  private path(key: string): string { return join(this.directory, `${digest(key)}.json`); }
  private masterKey(create: boolean): Promise<Buffer> {
    this.key ??= this.exclusive("vault-master-key", async () => {
      try {
        const keyring = this.keyring ?? new (await import("@napi-rs/keyring")).AsyncEntry(
          "may.mcp.vault.v1", digest(this.directory),
        );
        let value = await keyring.getPassword();
        if (value === undefined || value === null) {
          if (!create) throw new McpCredentialStoreError();
          value = randomBytes(32).toString("base64");
          await keyring.setPassword(value);
        }
        const key = Buffer.from(value, "base64");
        if (key.length !== 32) throw new Error();
        return key;
      } catch { throw new McpCredentialStoreError(); }
    }).catch((error: unknown) => { this.key = undefined; throw error; });
    return this.key;
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
