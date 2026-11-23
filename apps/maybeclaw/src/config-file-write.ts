import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveMayConfigTargetPath } from "@sortedyuan/may/config";
import { syncDirectory } from "@sortedyuan/may/storage";

export { resolveMayConfigTargetPath as resolveConfigTargetPath };

export interface DurableReplaceOptions {
  readonly mode?: number;
}

export class PostRenameDurabilityError extends Error {
  constructor(
    readonly targetPath: string,
    cause: unknown,
  ) {
    super(`配置已写入但目录持久化同步失败：${targetPath}`, { cause });
    this.name = "PostRenameDurabilityError";
  }
}

/**
 * Write and `fsync` a temporary sibling file, verify the target is unchanged immediately
 * before `rename` (minimizing external-editor TOCTOU windows), atomically rename into place,
 * and `fsync` the target directory.
 */
export async function writeDurableIfUnchanged(
  targetPath: string,
  contents: string,
  verifyUnchanged: () => Promise<void>,
  options: DurableReplaceOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = dirname(targetPath);
  const temporary = join(dir, `.${basename(targetPath)}.${randomUUID()}.pending`);
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verifyUnchanged();
    await rename(temporary, targetPath);
    renamed = true;
    try {
      await syncDirectory(dir);
    } catch (error) {
      throw new PostRenameDurabilityError(targetPath, error);
    }
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}
