import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileAccess } from "@sortedyuan/session/file-access";
import { MayConfigWriteError } from "./errors.js";
import { parseMayConfig } from "./parse.js";
import type { MayConfig } from "./types.js";

/** 创建完整的新配置；已有文件和符号链接保持原状。 */
export async function createMayConfig(path: string, value: unknown, options: { signal?: AbortSignal } = {}): Promise<MayConfig> {
  path = resolve(path);
  const config = parseMayConfig(value, path);
  const source = `${JSON.stringify(value, null, 2)}\n`;
  options.signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  return withFileAccess(path, "exclusive", async () => {
    let exists = true;
    try { await lstat(path); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      exists = false;
    }
    if (exists) throw new MayConfigWriteError(path, "the file already exists; reload it before continuing");
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(source, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      options.signal?.throwIfAborted();
      // link 原子发布完整内容，并拒绝替换其他进程刚创建的目标。
      await link(temporary, path);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new MayConfigWriteError(path, "creation failed; check directory permissions and whether another process created the file", { cause: error });
    } finally { await unlink(temporary); }
    return config;
  }, options);
}
