import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryLock, unlock } from "fs-native-extensions";

export interface FileAccessOptions {
  readonly initialize?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface AccessOwner { readonly identity: string; active: boolean }
const activeAccess = new AsyncLocalStorage<readonly AccessOwner[]>();

/** 同一路径的全部读取和修改需要使用这个入口，并等待 action 完成文件操作。 */
export async function withFileAccess<T>(
  path: string,
  mode: "shared" | "exclusive",
  action: () => Promise<T>,
  options: FileAccessOptions = {},
): Promise<T> {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("File access requires a nonempty path");
  if (mode !== "shared" && mode !== "exclusive") throw new TypeError("Invalid file access mode");
  if (typeof action !== "function") throw new TypeError("File access requires an action");
  if (options.initialize !== undefined && typeof options.initialize !== "boolean") throw new TypeError("Invalid file access initialization option");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("File access timeout must be a positive finite number");
  options.signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const accessPath = `${resolve(path)}.access`;
  const file = await openAccessFile(accessPath, mode, options.initialize !== false);
  let gate: FileHandle | undefined;
  let gateLocked = false;
  let locked = false;
  let owner: AccessOwner | undefined;
  try {
    const info = await validateAccessFile(accessPath, file);
    const identity = `${info.dev}:${info.ino}`;
    const inherited = activeAccess.getStore() ?? [];
    if (inherited.some(entry => entry.active && entry.identity === identity)) {
      throw Object.assign(new Error(`Nested file access for the same path is unsupported: ${path}`), { code: "FILE_ACCESS_REENTRANT" });
    }
    const gatePath = `${accessPath}.gate`;
    gate = await openAccessFile(gatePath, mode, options.initialize !== false);
    const gateInfo = await validateAccessFile(gatePath, gate);
    if (info.dev === gateInfo.dev && info.ino === gateInfo.ino) throw new Error(`File access markers must be different files: ${path}`);
    while (true) {
      options.signal?.throwIfAborted();
      if (performance.now() >= deadline) {
        throw Object.assign(new Error(`Timed out after ${timeoutMs}ms waiting for ${mode} file access: ${path}`), { code: "ETIMEDOUT" });
      }
      // 写入者等待已有读取者结束时保留 gate，使后续读取请求等待。
      if (!gateLocked) gateLocked = tryLock(gate.fd, 0, 0, { shared: mode === "shared" });
      if (gateLocked) {
        locked = tryLock(file.fd, 0, 0, { shared: mode === "shared" });
        if (mode === "shared") {
          unlock(gate.fd, 0, 0);
          gateLocked = false;
        }
        if (locked) break;
      }
      await delay(Math.min(10, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
    }
    await validateAccessFile(accessPath, file);
    await validateAccessFile(gatePath, gate);
    options.signal?.throwIfAborted();
    owner = { identity, active: true };
    return await activeAccess.run([...inherited, owner], action);
  } finally {
    if (owner) owner.active = false;
    try { if (locked) unlock(file.fd, 0, 0); }
    finally {
      try { if (gateLocked && gate) unlock(gate.fd, 0, 0); }
      finally {
        try { await gate?.close(); }
        finally { await file.close(); }
      }
    }
  }
}

async function openAccessFile(path: string, mode: "shared" | "exclusive", initialize: boolean): Promise<FileHandle> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = (mode === "shared" ? constants.O_RDONLY : constants.O_RDWR) | noFollow | constants.O_NONBLOCK;
  try { return await open(path, flags); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (!initialize) {
      throw Object.assign(new Error(`File access is not initialized: ${path}. Initialize it once with withFileAccess using directory write permission before opening read-only storage.`, { cause: error }), { code: "FILE_ACCESS_NOT_INITIALIZED" });
    }
  }
  try {
    const created = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await created.close();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return open(path, flags);
}

async function validateAccessFile(path: string, file: FileHandle) {
  const info = await file.stat({ bigint: true });
  const current = await lstat(path, { bigint: true });
  if (!info.isFile() || !current.isFile() || current.isSymbolicLink() || info.dev !== current.dev || info.ino !== current.ino) {
    throw new Error(`File access requires an unchanged regular file without symbolic links: ${path}`);
  }
  return info;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
