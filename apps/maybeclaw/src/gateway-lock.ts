import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tryLock, unlock } from "fs-native-extensions";

const owners = new Set<string>();

export class GatewayLock {
  private constructor(private readonly guard: number, private readonly identity: string,
    private readonly path: string, private readonly file: number, private readonly token: string) {}

  static acquire(directory: string): GatewayLock {
    const path = join(directory, "host.lock"), accessPath = `${path}.access`;
    const guard = openSync(accessPath, constants.O_CREAT | constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    let locked = false, registered = false;
    let identity = "";
    try {
      const info = checkedFile(accessPath, guard);
      identity = `${info.dev}:${info.ino}`;
      if (owners.has(identity)) throw new Error(`Gateway data directory is already in use: ${directory}`);
      locked = tryLock(guard, 0, 0);
      if (!locked) throw new Error(`Gateway data directory is already in use: ${directory}`);
      checkedFile(accessPath, guard);
      owners.add(identity); registered = true;
      recover(path);
      const file = openSync(path, "wx", 0o600), token = randomUUID();
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now(), token, format: "gateway-v1" }));
        fsyncSync(file);
        checkedFile(path, file);
        return new GatewayLock(guard, identity, path, file, token);
      } catch (error) {
        // 创建记录失败时只释放资源，保留记录供检查。
        closeSync(file);
        throw error;
      }
    } catch (error) {
      if (registered) owners.delete(identity);
      try { if (locked) unlock(guard, 0, 0); } finally { closeSync(guard); }
      throw error;
    }
  }

  release(): void {
    try {
      checkedFile(this.path, this.file);
      const owner = JSON.parse(readFileSync(this.path, "utf8")) as { token?: unknown };
      if (owner.token !== this.token) throw new Error(`Gateway host lock ownership changed: ${this.path}`);
      checkedFile(this.path, this.file);
      unlinkSync(this.path);
    } finally {
      try { closeSync(this.file); }
      finally {
        owners.delete(this.identity);
        try { unlock(this.guard, 0, 0); } finally { closeSync(this.guard); }
      }
    }
  }
}

function checkedFile(path: string, file: number) {
  const info = fstatSync(file, { bigint: true }), current = lstatSync(path, { bigint: true });
  if (!info.isFile() || !current.isFile() || current.isSymbolicLink() || info.nlink !== 1n ||
    info.dev !== current.dev || info.ino !== current.ino) throw new Error(`Gateway lock file identity changed: ${path}`);
  return info;
}

function recover(path: string): void {
  let file: number;
  try { file = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  try {
    if (checkedFile(path, file).size > 4096n) throw new Error(`Invalid Gateway lock metadata; inspect owner manually: ${path}`);
    const contents = readFileSync(file, "utf8");
    let owner: { pid?: unknown; hostname?: unknown };
    try { owner = JSON.parse(contents); }
    catch (error) { throw new Error(`Invalid Gateway lock metadata; inspect owner manually: ${path}`, { cause: error }); }
    if (!owner || owner.hostname !== hostname() || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      throw new Error(`Cannot verify Gateway lock owner; inspect owner manually: ${path}`);
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (!hasCode(error, "ESRCH")) throw new Error(`Cannot verify Gateway lock owner: ${path}`, { cause: error });
      checkedFile(path, file);
      if (readFileSync(path, "utf8") !== contents) throw new Error(`Gateway host lock ownership changed: ${path}`);
      unlinkSync(path);
      console.error(`Recovered Gateway lock for exited process ${owner.pid}: ${path}`);
      return;
    }
    throw new Error(`Gateway lock owner process ${owner.pid} is still running: ${path}`);
  } finally { closeSync(file); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
