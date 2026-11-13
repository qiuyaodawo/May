import { hasErrorCode } from "@sortedyuan/may/storage";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function safeRead(root: string, path: string, maxBytes: number): Promise<Buffer | undefined> {
  await assertParents(root, path);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maxBytes)
    throw new Error("Patch file is unsafe or exceeds its byte limit");
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size !== before.size ||
      stat.nlink > 1
    )
      throw new Error("Patch file changed while opening");
    const bytes = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const result = await file.read(bytes, position, bytes.length - position, position);
      if (!result.bytesRead) break;
      position += result.bytesRead;
    }
    const after = await file.stat();
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("Patch file changed while reading");
    await assertParents(root, path);
    return bytes.subarray(0, position);
  } finally {
    await file.close();
  }
}

export async function assertParents(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error("Patch path leaves its root");
  if ((await safeRoot(root)) !== root) throw new Error("Patch root identity changed");
  let cursor = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch parent is not a safe directory");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

export async function missingDirectories(root: string, path: string): Promise<string[]> {
  if (!inside(root, path)) throw new Error("Patch directory leaves its root");
  const missing: string[] = [];
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch parent is unsafe");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      missing.push(cursor);
    }
  }
  return missing;
}

export async function safeRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  for (;;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Patch directory is unsafe");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return realpath(absolute);
}

export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let parent = absolute;
  for (;;) {
    try {
      await safeRoot(parent);
      break;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      missing.unshift(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of missing) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    await safeRoot(directory);
  }
  return safeRoot(absolute);
}

export async function durableFile(path: string, content: string | Uint8Array, flag: "wx"): Promise<void> {
  const file = await open(path, flag, 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EPERM", "EACCES", "EINVAL", "EISDIR"].some((code) => hasErrorCode(error, code))
    )
      throw error;
  } finally {
    await directory?.close();
  }
}

export function checkedPath(root: string, path: string): string {
  assertRelativePath(path);
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error("Patch path leaves its root");
  return target;
}
export function assertRelativePath(path: string): void {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    /[\\:\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new Error("Unsafe or nonportable patch path");
}
export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
