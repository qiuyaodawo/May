import { lstat, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { CodingToolError } from "./errors.js";

export interface WorkspacePath {
  readonly absolute: string;
  readonly relative: string;
}

export async function resolveExistingWorkspacePath(
  cwd: string,
  inputPath: string,
): Promise<WorkspacePath> {
  return resolveWorkspacePath(cwd, inputPath, true);
}

export async function resolveWritableWorkspacePath(
  cwd: string,
  inputPath: string,
): Promise<WorkspacePath> {
  return resolveWorkspacePath(cwd, inputPath, false);
}

async function resolveWorkspacePath(
  cwd: string,
  inputPath: string,
  mustExist: boolean,
): Promise<WorkspacePath> {
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
    return { absolute: target, relative: displayPath };
  }
  if (mustExist) {
    throw new CodingToolError(
      "CODING_TOOL_PATH_NOT_FOUND",
      `Path not found: ${inputPath}`,
    );
  }

  await assertNotUnresolvedSymbolicLink(candidate, inputPath);
  await assertExistingParentInside(root, dirname(candidate), inputPath);
  return { absolute: candidate, relative: displayPath };
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
): Promise<void> {
  let parent = initialParent;
  while (true) {
    try {
      const existingParent = await realpath(parent);
      assertInside(root, existingParent, inputPath);
      return;
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
