import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { MayConfig } from "@may/config";

import { MaybeCodeConfigError } from "./errors.js";

export const MAYBECODE_APPLICATION_ID = "maybecode";
export const SYSTEM_INSTRUCTIONS_FILENAME = "system.md";
export const PROJECT_INSTRUCTIONS_FILENAME = "AGENTS.md";
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export const DEFAULT_MAYBE_CODE_INSTRUCTIONS = `You are MaybeCode, a coding agent working in a local workspace.
Use tools to inspect the project before making claims about it.
Keep changes focused, preserve existing conventions, and verify changes when practical.
Workspace paths passed to file tools must be relative to the workspace.`;

export type InstructionSource =
  | { readonly type: "built-in" }
  | { readonly type: "explicit" }
  | { readonly type: "runtime" }
  | { readonly type: "file"; readonly path: string };

export interface InstructionDocument {
  readonly source: InstructionSource;
  readonly content: string;
}

export interface MaybeCodeInstructions {
  readonly system: InstructionDocument;
  readonly runtime?: InstructionDocument;
  readonly project?: InstructionDocument;
  readonly effective: string;
}

export interface LoadMaybeCodeInstructionsOptions {
  readonly workspace: string;
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  readonly runtimeInstructions?: string;
}

export function resolveMaybeCodeInstructionsDirectory(
  config: MayConfig,
): string | undefined {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.instructionsDirectory;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.instructionsDirectory must be a non-empty string",
    );
  }

  const expanded = expandHome(value);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(dirname(resolve(config.path)), expanded);
}

export async function loadMaybeCodeInstructions(
  options: LoadMaybeCodeInstructionsOptions,
): Promise<MaybeCodeInstructions> {
  const system = options.instructions !== undefined
    ? explicitInstructions(options.instructions)
    : options.instructionsDirectory !== undefined
    ? await fileInstructions(
        join(resolve(options.instructionsDirectory), SYSTEM_INSTRUCTIONS_FILENAME),
        "system instructions",
      )
    : {
        source: { type: "built-in" } as const,
        content: DEFAULT_MAYBE_CODE_INSTRUCTIONS,
      };
  const project = await optionalProjectInstructions(options.workspace);
  const runtime = options.runtimeInstructions === undefined
    ? undefined
    : runtimeInstructions(options.runtimeInstructions);

  const sections = [system.content];
  if (runtime !== undefined) {
    sections.push(`# Runtime environment\n\n${runtime.content}`);
  }
  if (project !== undefined) {
    sections.push(`# Project instructions\n\n${project.content}`);
  }

  return {
    system,
    ...(runtime === undefined ? {} : { runtime }),
    ...(project === undefined ? {} : { project }),
    effective: sections.join("\n\n"),
  };
}

function runtimeInstructions(content: string): InstructionDocument {
  if (content.trim() === "") {
    throw new MaybeCodeConfigError("Runtime instructions must not be empty");
  }
  assertSize(Buffer.byteLength(content, "utf8"), "Runtime instructions");
  return { source: { type: "runtime" }, content };
}

function explicitInstructions(content: string): InstructionDocument {
  if (content.trim() === "") {
    throw new MaybeCodeConfigError("Explicit instructions must not be empty");
  }
  assertSize(Buffer.byteLength(content, "utf8"), "Explicit instructions");
  return { source: { type: "explicit" }, content };
}

async function optionalProjectInstructions(
  workspace: string,
): Promise<InstructionDocument | undefined> {
  const path = join(resolve(workspace), PROJECT_INSTRUCTIONS_FILENAME);
  try {
    const information = await stat(path);
    if (!information.isFile()) {
      throw new MaybeCodeConfigError(
        `Project instructions path is not a file: ${path}`,
      );
    }
    assertSize(information.size, `Project instructions at ${path}`);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof MaybeCodeConfigError) throw error;
    throw new MaybeCodeConfigError(
      `Unable to read project instructions at ${path}`,
      { cause: error },
    );
  }

  const document = await fileInstructions(path, "project instructions");
  return document.content.trim() === "" ? undefined : document;
}

async function fileInstructions(
  path: string,
  label: string,
): Promise<InstructionDocument> {
  let contents: Buffer;
  try {
    const information = await stat(path);
    if (!information.isFile()) {
      throw new MaybeCodeConfigError(`${label} path is not a file: ${path}`);
    }
    assertSize(information.size, `${capitalize(label)} at ${path}`);
    contents = await readFile(path);
  } catch (error) {
    if (error instanceof MaybeCodeConfigError) throw error;
    throw new MaybeCodeConfigError(
      `Unable to read ${label} at ${path}`,
      { cause: error },
    );
  }

  assertSize(contents.byteLength, `${capitalize(label)} at ${path}`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new MaybeCodeConfigError(
      `${capitalize(label)} at ${path} must be valid UTF-8`,
      { cause: error },
    );
  }
  if (label === "system instructions" && content.trim() === "") {
    throw new MaybeCodeConfigError(`System instructions at ${path} must not be empty`);
  }
  return { source: { type: "file", path }, content };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function assertSize(size: number, label: string): void {
  if (size > MAX_INSTRUCTIONS_BYTES) {
    throw new MaybeCodeConfigError(
      `${label} exceeds the ${MAX_INSTRUCTIONS_BYTES}-byte limit (${size} bytes)`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
