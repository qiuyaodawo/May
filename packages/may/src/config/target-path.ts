import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hasErrorCode } from "../storage/index.js";

const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolve a configuration path to a single canonical target file path so that locks,
 * atomic replacements, and directory `fsync` operate on the same physical file even
 * when callers pass a symbolic link or aliased directory path.
 * @experimental
 */
export async function resolveMayConfigTargetPath(path: string): Promise<string> {
  let current = resolve(path);
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const target = await readlink(current);
        current = resolve(dirname(current), target);
        continue;
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    const canonicalParent = await canonicalExistingAncestor(dirname(current), depth);
    return join(canonicalParent, basename(current));
  }
  throw new Error(`Configuration symbolic link loop or depth exceeded: ${path}`);
}

async function canonicalExistingAncestor(directory: string, depth: number): Promise<string> {
  if (depth >= MAX_SYMLINK_DEPTH) {
    throw new Error(`Configuration directory symbolic link loop or depth exceeded: ${directory}`);
  }
  try {
    return await realpath(directory);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      const target = await readlink(directory);
      return canonicalExistingAncestor(resolve(dirname(directory), target), depth + 1);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const parent = dirname(directory);
  if (parent === directory) return directory;
  return join(await canonicalExistingAncestor(parent, depth), basename(directory));
}
