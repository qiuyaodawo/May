import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

export interface ResolvedVaultPath {
  /** 绝对路径。 */
  readonly absolute: string;
  /** 库内相对路径，使用 "/" 分隔。 */
  readonly relative: string;
}

/**
 * 解析库内路径，拒绝越界、符号链接与硬链接，避免读写到库外文件。
 */
export async function resolveVaultPath(
  root: string,
  input: string,
  options: { readonly mustExist: boolean },
): Promise<ResolvedVaultPath> {
  const canonicalRoot = await realpath(root);
  if (input.startsWith("/") || input.startsWith("\\") || /^[a-zA-Z]:/u.test(input)) {
    throw new VaultPathError(`必须是个人数据库中的相对路径：${input}`);
  }
  const normalized = input.replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (normalized === "") throw new VaultPathError("路径不能为空");
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new VaultPathError(`路径包含非法片段：${input}`);
  }
  if (/[<>:"\\|?*]/u.test(normalized) || /[\u0000-\u001F]/u.test(normalized)) {
    throw new VaultPathError(`路径包含非法字符：${input}`);
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new VaultPathError(`个人数据库只保存 Markdown 文件：${input}`);
  }

  const candidate = resolve(canonicalRoot, normalized);
  assertInside(canonicalRoot, candidate, input);

  let target: string | undefined;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (target !== undefined) {
    assertInside(canonicalRoot, target, input);
    const information = await lstat(candidate);
    if (information.isSymbolicLink()) throw new VaultPathError(`不接受符号链接：${input}`);
    const stats = await stat(target);
    if (!stats.isFile()) throw new VaultPathError(`路径不是文件：${input}`);
    if (stats.nlink > 1) throw new VaultPathError(`无法确认硬链接文件属于个人数据库：${input}`);
    return { absolute: target, relative: display(target, canonicalRoot) };
  }
  if (options.mustExist) throw new VaultPathError(`文件不存在：${input}`);
  await assertExistingParentInside(canonicalRoot, dirname(candidate), input);
  return { absolute: candidate, relative: display(candidate, canonicalRoot) };
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function assertInside(root: string, target: string, input: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new VaultPathError(`路径超出个人数据库范围：${input}`);
  }
}

function display(absolute: string, root: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/** 找到最近的已存在上级目录，确认它位于库内且不是符号链接。 */
async function assertExistingParentInside(root: string, initialParent: string, input: string): Promise<void> {
  let parent = initialParent;
  while (true) {
    try {
      const existing = await lstat(parent);
      if (existing.isSymbolicLink()) throw new VaultPathError(`不接受符号链接目录：${input}`);
      assertInside(root, await realpath(parent), input);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const next = dirname(parent);
    if (next === parent) throw new VaultPathError(`无法确认上级目录位于个人数据库内：${input}`);
    parent = next;
  }
}
