import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { MayError, omitUndefined } from "@sortedyuan/may/core";
import { hasErrorCode, withFileAccess } from "@sortedyuan/may/storage";

/**
 * Secrets are opaque to the host. Implementations must not log their values.
 * @experimental
 */
export interface McpCredentialStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Serializes login/refresh/logout for one credential identity, across processes if durable. */
  exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** @experimental */
export class McpCredentialStoreError extends MayError {
  constructor(
    message = "MCP credential vault is unavailable; unlock the OS keyring or provide a secure credential store",
    readonly reason = "storage-unavailable",
  ) {
    super("MCP_CREDENTIAL_STORE_UNAVAILABLE", message, { cause: new Error(reason) });
  }
}

/**
 * For headless integrations/tests that deliberately want process-lifetime credentials.
 * @experimental
 */
export class InMemoryMcpCredentialStore implements McpCredentialStore {
  private readonly values = new Map<string, unknown>();
  private readonly locks = new Map<string, Promise<unknown>>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return work();
      });
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

/** @experimental */
export interface McpVaultKeyring {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
}

/**
 * AES-256-GCM records; only their 32-byte master key lives in the OS keyring.
 * @experimental
 */
export class KeyringMcpCredentialStore implements McpCredentialStore {
  readonly directory: string;
  private key: Promise<Buffer> | undefined;
  constructor(
    directory: string,
    private readonly keyring?: McpVaultKeyring,
  ) {
    this.directory = resolve(directory);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const path = this.path(key);
    try {
      const source = await withFileAccess(path, "shared", async () => {
        const info = await stat(path);
        if (info.size > 2 * 1024 * 1024) throw new McpCredentialStoreError();
        return readFile(path, "utf8");
      });
      const record = JSON.parse(source) as {
        version: number;
        nonce: string;
        tag: string;
        ciphertext: string;
      };
      if (record.version !== 1) throw new McpCredentialStoreError();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await this.masterKey(false),
        Buffer.from(record.nonce, "base64"),
      );
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
      try {
        return JSON.parse(plain.toString("utf8")) as T;
      } finally {
        plain.fill(0);
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw new McpCredentialStoreError(
        undefined,
        error instanceof SyntaxError
          ? "invalid-record"
          : hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")
            ? "permission-denied"
            : error instanceof McpCredentialStoreError
              ? error.reason
              : "invalid-or-unreadable-record",
      );
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    try {
      const plain = Buffer.from(JSON.stringify(value));
      if (plain.length > 1024 * 1024) throw new McpCredentialStoreError("MCP credential record is too large");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.masterKey(true), nonce);
      cipher.setAAD(Buffer.from(key));
      let ciphertext: Buffer;
      try {
        ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      } finally {
        plain.fill(0);
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const record = JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      });
      await withFileAccess(path, "exclusive", () => writeFileAtomic(path, record, { mode: 0o600 }));
    } catch {
      throw new McpCredentialStoreError();
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    try {
      await withFileAccess(path, "exclusive", () => unlink(path));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw new McpCredentialStoreError();
    }
  }

  async exclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${digest(key)}.lock`);
    let entered = false;
    try {
      return await withFileAccess(
        path,
        "exclusive",
        async () => {
          entered = true;
          signal?.throwIfAborted();
          return work();
        },
        omitUndefined({ timeoutMs: 10_000, signal }),
      );
    } catch (error) {
      if (entered || signal?.aborted) throw error;
      throw new McpCredentialStoreError(
        undefined,
        hasErrorCode(error, "ETIMEDOUT") ? "lock-timeout" : "storage-unavailable",
      );
    }
  }

  private path(key: string): string {
    return join(this.directory, `${digest(key)}.json`);
  }
  private masterKey(create: boolean): Promise<Buffer> {
    this.key ??= this.exclusive("vault-master-key", async () => {
      try {
        const keyring =
          this.keyring ?? new (await import("@napi-rs/keyring")).AsyncEntry("may.mcp.vault.v1", digest(this.directory));
        let value = await keyring.getPassword();
        if (value === undefined || value === null) {
          if (!create) throw new McpCredentialStoreError();
          value = randomBytes(32).toString("base64");
          await keyring.setPassword(value);
        }
        const key = Buffer.from(value, "base64");
        if (key.length !== 32) throw new Error();
        return key;
      } catch {
        throw new McpCredentialStoreError(undefined, "keyring-unavailable");
      }
    }).catch((error: unknown) => {
      this.key = undefined;
      throw error;
    });
    return this.key;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
