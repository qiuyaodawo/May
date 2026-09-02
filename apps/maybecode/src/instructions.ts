import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CodingInstructionsError,
  DEFAULT_CODING_INSTRUCTIONS_MAX_BYTES,
  DEFAULT_PROJECT_INSTRUCTIONS_FILENAME,
  DEFAULT_SYSTEM_INSTRUCTIONS_FILENAME,
  loadCodingInstructions,
  type CodingInstructionDocument,
  type CodingInstructions,
  type CodingInstructionSource,
} from "@may/coding-tools/instructions";
import type { MayConfig } from "@may/config";

import { MaybeCodeConfigError } from "./errors.js";

export const MAYBECODE_APPLICATION_ID = "maybecode";
export const SYSTEM_INSTRUCTIONS_FILENAME =
  DEFAULT_SYSTEM_INSTRUCTIONS_FILENAME;
export const PROJECT_INSTRUCTIONS_FILENAME =
  DEFAULT_PROJECT_INSTRUCTIONS_FILENAME;
export const MAX_INSTRUCTIONS_BYTES =
  DEFAULT_CODING_INSTRUCTIONS_MAX_BYTES;

export const DEFAULT_MAYBE_CODE_INSTRUCTIONS = `You are MaybeCode, a coding agent working in a local workspace.
Use tools to inspect the project before making claims about it.
Keep changes focused, preserve existing conventions, and verify changes when practical.
Workspace paths passed to file tools must be relative to the workspace.`;

/** Compatibility alias for the reusable coding-instructions source. */
export type InstructionSource = CodingInstructionSource;

/** Compatibility alias for the reusable coding-instructions document. */
export type InstructionDocument = CodingInstructionDocument;

/** MaybeCode's product name for the reusable instruction set. */
export type MaybeCodeInstructions = CodingInstructions;

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
  try {
    return await loadCodingInstructions({
      workspace: options.workspace,
      defaultSystemInstructions: DEFAULT_MAYBE_CODE_INSTRUCTIONS,
      systemInstructionsFilename: SYSTEM_INSTRUCTIONS_FILENAME,
      projectInstructionsFilename: PROJECT_INSTRUCTIONS_FILENAME,
      sectionLabels: {
        runtime: "Runtime environment",
        project: "Project instructions",
      },
      maxBytes: MAX_INSTRUCTIONS_BYTES,
      ...(options.instructions === undefined
        ? {}
        : { systemInstructions: options.instructions }),
      ...(options.instructionsDirectory === undefined
        ? {}
        : { instructionsDirectory: options.instructionsDirectory }),
      ...(options.runtimeInstructions === undefined
        ? {}
        : { runtimeInstructions: options.runtimeInstructions }),
    });
  } catch (error) {
    if (error instanceof CodingInstructionsError) {
      throw new MaybeCodeConfigError(error.message, { cause: error });
    }
    throw error;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
