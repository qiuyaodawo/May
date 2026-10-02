import type { WorkspacePath } from "./workspace-path.js";
import { stat } from "node:fs/promises";
import { EnvironmentError, type EnvironmentProvider } from "@may/environment";

/**
 * 一次受保护的文件操作。工具已经解析并校验过路径，宿主无需再自行解析。
 *
 * `run()` 在同一把按规范化路径取得的锁内执行，宿主在锁内做检查和版本记录，
 * 因此“读取并记录版本”与“检查并写入”各自是一个完整的操作边界。
 */
export interface WorkspaceFileOperation<T> {
  readonly tool: "read" | "edit" | "write";
  /** 已经过工作区路径保护解析的路径；软链接与别名指向同一份内容。 */
  readonly path: WorkspacePath;
  /** 目标文件当前是否存在。 */
  readonly exists: boolean;
  /** 实际的文件操作；返回值交回宿主用于版本记录。 */
  run(): Promise<T>;
}

export type WorkspaceFileGuard = <T>(
  operation: WorkspaceFileOperation<T>,
) => Promise<T>;

/** 目标文件当前是否存在；软链接、目录与路径不存在都视为不可用。 */
export async function assertFileExistence(
  path: WorkspacePath,
  signal?: AbortSignal,
  environment?: EnvironmentProvider,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    if (environment !== undefined) return (await environment.statFile(path.relative, signal === undefined ? undefined : { signal })).type === "file";
    const information = await stat(path.absolute);
    return information.isFile();
  } catch (error) {
    if (error instanceof EnvironmentError && error.code === "ENVIRONMENT_PATH_NOT_FOUND") return false;
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

/** Windows 文件系统不区分大小写，统一为小写键值。 */
export function workspaceFileKey(path: WorkspacePath): string {
  const normalized = path.absolute.replace(/\\/gu, "/");
  const key = (path.platform ?? process.platform) === "win32" ? normalized.toLowerCase() : normalized;
  return path.environmentId === undefined ? key : `${path.environmentId}:${key}`;
}
