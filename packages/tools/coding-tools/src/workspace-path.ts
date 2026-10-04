import { lstat, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
  posix,
} from "node:path";
import { EnvironmentError, resolveEnvironmentPath, type EnvironmentProvider } from "@may/environment";
import { CodingToolError } from "./errors.js";

export interface WorkspacePath {
  readonly absolute: string;
  readonly relative: string;
  readonly environmentId?: string;
  readonly platform?: NodeJS.Platform;
}

export interface WorkspacePathOptions {
  readonly environment?: EnvironmentProvider;
  readonly signal?: AbortSignal;
  /**
   * Hard links cannot be proven to belong exclusively to the workspace.
   * Keep this disabled unless the workspace itself is fully trusted.
   */
  readonly allowHardLinks?: boolean;
}

export async function resolveExistingWorkspacePath(
  cwd: string,
  inputPath: string,
  options: WorkspacePathOptions = {},
): Promise<WorkspacePath> {
  return resolveWorkspacePath(cwd, inputPath, true, options);
}

export async function resolveWritableWorkspacePath(
  cwd: string,
  inputPath: string,
  options: WorkspacePathOptions = {},
): Promise<WorkspacePath> {
  return resolveWorkspacePath(cwd, inputPath, false, options);
}

async function resolveWorkspacePath(
  cwd: string,
  inputPath: string,
  mustExist: boolean,
  options: WorkspacePathOptions,
): Promise<WorkspacePath> {
  if (options.environment !== undefined) {
    return resolveProviderPath(cwd, inputPath, mustExist, options.environment, options);
  }
  const root = await resolveWorkspaceRoot(cwd);
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, inputPath);
  const displayPath = toDisplayPath(relative(root, candidate));

  let target: string | undefined;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  if (target !== undefined) {
    assertInside(root, target, inputPath);
    await assertSafeLinkCount(target, inputPath, options.allowHardLinks === true);
    return { absolute: target, relative: displayPath };
  }
  if (mustExist) {
    throw new CodingToolError(
      "CODING_TOOL_PATH_NOT_FOUND",
      `Path not found: ${inputPath}`,
    );
  }

  await assertNotUnresolvedSymbolicLink(candidate, inputPath);
  const parent = await assertExistingParentInside(root, dirname(candidate), inputPath);
  return { absolute: resolve(parent, basename(candidate)), relative: displayPath };
}

async function resolveProviderPath(
  cwd: string,
  inputPath: string,
  mustExist: boolean,
  environment: EnvironmentProvider,
  options: WorkspacePathOptions,
): Promise<WorkspacePath> {
  options.signal?.throwIfAborted();
  const description = await environment.describe();
  const pathApi = description.platform === "win32" ? win32 : posix;
  if (pathApi.relative(description.workingDirectory, cwd) !== "") {
    throw new CodingToolError("CODING_TOOL_INVALID_CWD", "cwd must match the environment working directory");
  }
  const input = pathApi.isAbsolute(inputPath)
    ? pathApi.relative(description.workingDirectory, inputPath)
    : inputPath;
  const resolved = resolveEnvironmentPath(description.workingDirectory, input || ".", { platform: description.platform });
  const operationOptions = options.signal === undefined ? undefined : { signal: options.signal };
  let information;
  try {
    information = await environment.statFile(resolved.relative, operationOptions);
  } catch (error) {
    if (!(error instanceof EnvironmentError) || error.code !== "ENVIRONMENT_PATH_NOT_FOUND") throw error;
    if (mustExist) {
      throw new CodingToolError("CODING_TOOL_PATH_NOT_FOUND", `Path not found: ${inputPath}`, { cause: error });
    }
  }
  if (information?.type === "file" && (information.linkCount ?? 1) > 1 && options.allowHardLinks !== true) {
    throw new CodingToolError("CODING_TOOL_UNSAFE_HARD_LINK", `Cannot verify workspace containment for hard-linked file: ${inputPath}`);
  }
  let absolute = information?.absolutePath ?? resolved.absolute;
  if (information === undefined) {
    let parent = pathApi.dirname(resolved.absolute);
    while (true) {
      const parentRelative = pathApi.relative(description.workingDirectory, parent) || ".";
      try {
        const existing = await environment.statFile(parentRelative, operationOptions);
        absolute = pathApi.join(existing.absolutePath, pathApi.relative(parent, resolved.absolute));
        break;
      } catch (error) {
        if (!(error instanceof EnvironmentError) || error.code !== "ENVIRONMENT_PATH_NOT_FOUND") throw error;
      }
      const next = pathApi.dirname(parent);
      if (next === parent) throw new CodingToolError("CODING_TOOL_INVALID_CWD", "environment working directory does not exist");
      parent = next;
    }
  }
  return {
    absolute,
    relative: resolveEnvironmentPath(description.workingDirectory, pathApi.relative(description.workingDirectory, absolute) || ".", { platform: description.platform }).relative,
    environmentId: environment.environmentId,
    platform: description.platform,
  };
}

async function assertSafeLinkCount(
  target: string,
  inputPath: string,
  allowHardLinks: boolean,
): Promise<void> {
  if (allowHardLinks) return;
  const information = await stat(target);
  if (!information.isFile() || information.nlink <= 1) return;
  throw new CodingToolError(
    "CODING_TOOL_UNSAFE_HARD_LINK",
    `Cannot verify workspace containment for hard-linked file: ${inputPath}`,
  );
}

async function assertNotUnresolvedSymbolicLink(
  candidate: string,
  inputPath: string,
): Promise<void> {
  try {
    const information = await lstat(candidate);
    if (information.isSymbolicLink()) {
      throw new CodingToolError(
        "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
        `Cannot verify symbolic link target: ${inputPath}`,
      );
    }
  } catch (error) {
    if (error instanceof CodingToolError) throw error;
    if (!isMissingPathError(error)) throw error;
  }
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(resolve(cwd));
  } catch (error) {
    throw new CodingToolError(
      "CODING_TOOL_INVALID_CWD",
      `Workspace does not exist: ${cwd}`,
      { cause: error },
    );
  }
  const information = await stat(root);
  if (!information.isDirectory()) {
    throw new CodingToolError(
      "CODING_TOOL_INVALID_CWD",
      `Workspace is not a directory: ${cwd}`,
    );
  }
  return root;
}

async function assertExistingParentInside(
  root: string,
  initialParent: string,
  inputPath: string,
): Promise<string> {
  let parent = initialParent;
  while (true) {
    try {
      const existingParent = await realpath(parent);
      assertInside(root, existingParent, inputPath);
      return resolve(existingParent, relative(parent, initialParent));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const nextParent = dirname(parent);
    if (nextParent === parent) {
      throw new CodingToolError(
        "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
        `Path is outside the workspace: ${inputPath}`,
      );
    }
    parent = nextParent;
  }
}

function assertInside(root: string, target: string, inputPath: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new CodingToolError(
      "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
      `Path is outside the workspace: ${inputPath}`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function toDisplayPath(path: string): string {
  return path === "" ? "." : path.split(sep).join("/");
}
