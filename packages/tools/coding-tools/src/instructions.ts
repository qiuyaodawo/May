import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";

export const DEFAULT_CODING_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
export const DEFAULT_SYSTEM_INSTRUCTIONS_FILENAME = "system.md";
export const DEFAULT_PROJECT_INSTRUCTIONS_FILENAME = "AGENTS.md";

export interface CodingInstructionSectionLabels {
  readonly runtime: string;
  readonly project: string;
}

export const DEFAULT_CODING_INSTRUCTION_SECTION_LABELS:
  CodingInstructionSectionLabels = {
    runtime: "Runtime environment",
    project: "Project instructions",
  };

export type CodingInstructionSource =
  | { readonly type: "built-in" }
  | { readonly type: "explicit" }
  | { readonly type: "runtime" }
  | { readonly type: "file"; readonly path: string };

export interface CodingInstructionDocument {
  readonly source: CodingInstructionSource;
  readonly content: string;
}

export interface CodingInstructions {
  readonly system: CodingInstructionDocument;
  readonly runtime?: CodingInstructionDocument;
  readonly project?: CodingInstructionDocument;
  readonly effective: string;
}

export interface LoadCodingInstructionsOptions {
  /** Workspace whose root may contain the project instruction file. */
  readonly workspace: string;
  /** Application-owned fallback system instructions. */
  readonly defaultSystemInstructions: string;
  /** Explicit system instructions. These take precedence over a file. */
  readonly systemInstructions?: string;
  /** Directory containing the configured system instruction file. */
  readonly instructionsDirectory?: string;
  /** Instructions describing the current runtime environment. */
  readonly runtimeInstructions?: string;
  /** File read from `instructionsDirectory`. */
  readonly systemInstructionsFilename?: string;
  /**
   * Optional file read from the workspace root. Pass `false` to disable
   * project instruction discovery.
   */
  readonly projectInstructionsFilename?: string | false;
  /** Markdown section labels used to assemble `effective`. */
  readonly sectionLabels?: Partial<CodingInstructionSectionLabels>;
  /** Maximum UTF-8 byte size of each instruction document. */
  readonly maxBytes?: number;
  /** Optional cancellation signal for filesystem reads. */
  readonly signal?: AbortSignal;
}

export type CodingInstructionsErrorCode =
  | "CODING_INSTRUCTIONS_INVALID_OPTION"
  | "CODING_INSTRUCTIONS_INVALID_WORKSPACE"
  | "CODING_INSTRUCTIONS_READ_FAILED"
  | "CODING_INSTRUCTIONS_NOT_A_FILE"
  | "CODING_INSTRUCTIONS_UNSAFE_LINK"
  | "CODING_INSTRUCTIONS_OUTSIDE_WORKSPACE"
  | "CODING_INSTRUCTIONS_TOO_LARGE"
  | "CODING_INSTRUCTIONS_INVALID_UTF8"
  | "CODING_INSTRUCTIONS_EMPTY";

export class CodingInstructionsError extends Error {
  readonly code: CodingInstructionsErrorCode;

  constructor(
    code: CodingInstructionsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodingInstructionsError";
    this.code = code;
  }
}

/**
 * Load and combine system, runtime, and workspace-root instructions.
 *
 * Prompt content and filenames remain application policy. Instruction files
 * are bounded strict UTF-8 text; symbolic/reparse points and hard links are
 * rejected so an apparently local file cannot disclose external contents.
 */
export async function loadCodingInstructions(
  options: Readonly<LoadCodingInstructionsOptions>,
): Promise<CodingInstructions> {
  const settings = validateOptions(options);
  throwIfAborted(options.signal);

  const workspace = await resolveWorkspace(options.workspace);
  const system = options.systemInstructions !== undefined
    ? textDocument(
        options.systemInstructions,
        "explicit",
        "Explicit instructions",
        settings.maxBytes,
      )
    : options.instructionsDirectory !== undefined
    ? await loadRequiredFile(
        options.instructionsDirectory,
        settings.systemFilename,
        "System instructions",
        settings.maxBytes,
        options.signal,
      )
    : textDocument(
        options.defaultSystemInstructions,
        "built-in",
        "Default system instructions",
        settings.maxBytes,
      );

  const runtime = options.runtimeInstructions === undefined
    ? undefined
    : textDocument(
        options.runtimeInstructions,
        "runtime",
        "Runtime instructions",
        settings.maxBytes,
      );
  const project = settings.projectFilename === false
    ? undefined
    : await loadOptionalProjectFile(
        workspace,
        settings.projectFilename,
        settings.maxBytes,
        options.signal,
      );

  const sections = [system.content];
  if (runtime !== undefined) {
    sections.push(`# ${settings.labels.runtime}\n\n${runtime.content}`);
  }
  if (project !== undefined) {
    sections.push(`# ${settings.labels.project}\n\n${project.content}`);
  }

  return {
    system,
    ...(runtime === undefined ? {} : { runtime }),
    ...(project === undefined ? {} : { project }),
    effective: sections.join("\n\n"),
  };
}

interface ValidatedOptions {
  readonly maxBytes: number;
  readonly systemFilename: string;
  readonly projectFilename: string | false;
  readonly labels: CodingInstructionSectionLabels;
}

function validateOptions(
  options: Readonly<LoadCodingInstructionsOptions>,
): ValidatedOptions {
  if (options.workspace.trim() === "") {
    throw invalidOption("workspace must not be empty");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_CODING_INSTRUCTIONS_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw invalidOption("maxBytes must be a positive safe integer");
  }

  const systemFilename = instructionFilename(
    options.systemInstructionsFilename ?? DEFAULT_SYSTEM_INSTRUCTIONS_FILENAME,
    "systemInstructionsFilename",
  );
  const projectFilename = options.projectInstructionsFilename === false
    ? false
    : instructionFilename(
        options.projectInstructionsFilename ??
          DEFAULT_PROJECT_INSTRUCTIONS_FILENAME,
        "projectInstructionsFilename",
      );
  const labels = {
    runtime: sectionLabel(
      options.sectionLabels?.runtime ??
        DEFAULT_CODING_INSTRUCTION_SECTION_LABELS.runtime,
      "sectionLabels.runtime",
    ),
    project: sectionLabel(
      options.sectionLabels?.project ??
        DEFAULT_CODING_INSTRUCTION_SECTION_LABELS.project,
      "sectionLabels.project",
    ),
  };
  return { maxBytes, systemFilename, projectFilename, labels };
}

function instructionFilename(value: string, option: string): string {
  if (
    value.trim() === "" || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\") || value.includes("\0")
  ) {
    throw invalidOption(`${option} must be a single non-empty filename`);
  }
  return value;
}

function sectionLabel(value: string, option: string): string {
  if (value.trim() === "") {
    throw invalidOption(`${option} must not be empty`);
  }
  if (value.includes("\r") || value.includes("\n")) {
    throw invalidOption(`${option} must fit on one line`);
  }
  return value;
}

async function resolveWorkspace(workspace: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(resolve(workspace));
    const information = await stat(root);
    if (!information.isDirectory()) {
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_INVALID_WORKSPACE",
        `Workspace is not a directory: ${workspace}`,
      );
    }
  } catch (error) {
    if (error instanceof CodingInstructionsError) throw error;
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_INVALID_WORKSPACE",
      `Unable to access workspace: ${workspace}`,
      { cause: error },
    );
  }
  return root;
}

function textDocument(
  content: string,
  source: "built-in" | "explicit" | "runtime",
  label: string,
  maxBytes: number,
): CodingInstructionDocument {
  if (content.trim() === "") {
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_EMPTY",
      `${label} must not be empty`,
    );
  }
  assertSize(Buffer.byteLength(content, "utf8"), label, maxBytes);
  return { source: { type: source }, content };
}

async function loadRequiredFile(
  directory: string,
  filename: string,
  label: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<CodingInstructionDocument> {
  let root: string;
  try {
    root = await realpath(resolve(directory));
    const information = await stat(root);
    if (!information.isDirectory()) {
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_READ_FAILED",
        `Instructions directory is not a directory: ${directory}`,
      );
    }
  } catch (error) {
    if (error instanceof CodingInstructionsError) throw error;
    if (isAbortError(error, signal)) throw error;
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_READ_FAILED",
      `Unable to access instructions directory: ${directory}`,
      { cause: error },
    );
  }
  return loadSafeFile(root, filename, label, maxBytes, signal);
}

async function loadOptionalProjectFile(
  workspace: string,
  filename: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<CodingInstructionDocument | undefined> {
  try {
    const document = await loadSafeFile(
      workspace,
      filename,
      "Project instructions",
      maxBytes,
      signal,
    );
    return document.content.trim() === "" ? undefined : document;
  } catch (error) {
    if (
      error instanceof CodingInstructionsError &&
      error.code === "CODING_INSTRUCTIONS_READ_FAILED" &&
      isMissingPathError(error.cause)
    ) {
      return undefined;
    }
    throw error;
  }
}

async function loadSafeFile(
  root: string,
  filename: string,
  label: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<CodingInstructionDocument> {
  const candidate = resolve(root, filename);
  assertInside(root, candidate, candidate);

  let target: string;
  try {
    throwIfAborted(signal);
    const linkInformation = await lstat(candidate);
    if (linkInformation.isSymbolicLink()) {
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_UNSAFE_LINK",
        `${label} must not be a symbolic link or reparse point: ${candidate}`,
      );
    }
    if (linkInformation.isFile() && linkInformation.nlink > 1) {
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_UNSAFE_LINK",
        `${label} must not be a hard link: ${candidate}`,
      );
    }
    target = await realpath(candidate);
    assertInside(root, target, candidate);
    const information = await stat(target);
    if (!information.isFile()) {
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_NOT_A_FILE",
        `${label} path is not a file: ${candidate}`,
      );
    }
    assertSize(information.size, `${label} at ${candidate}`, maxBytes);
  } catch (error) {
    if (error instanceof CodingInstructionsError) throw error;
    if (isAbortError(error, signal)) throw error;
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_READ_FAILED",
      `Unable to read ${label.toLowerCase()} at ${candidate}`,
      { cause: error },
    );
  }

  let contents: Buffer;
  try {
    contents = signal === undefined
      ? await readFile(target)
      : await readFile(target, { signal });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_READ_FAILED",
      `Unable to read ${label.toLowerCase()} at ${candidate}`,
      { cause: error },
    );
  }
  assertSize(contents.byteLength, `${label} at ${candidate}`, maxBytes);

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_INVALID_UTF8",
      `${label} at ${candidate} must be valid UTF-8`,
      { cause: error },
    );
  }
  if (label === "System instructions" && content.trim() === "") {
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_EMPTY",
      `${label} at ${candidate} must not be empty`,
    );
  }
  return { source: { type: "file", path: target }, content };
}

function assertInside(root: string, target: string, displayPath: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new CodingInstructionsError(
      "CODING_INSTRUCTIONS_OUTSIDE_WORKSPACE",
      `Instruction path resolves outside its root: ${displayPath}`,
    );
  }
}

function assertSize(size: number, label: string, maxBytes: number): void {
  if (size <= maxBytes) return;
  throw new CodingInstructionsError(
    "CODING_INSTRUCTIONS_TOO_LARGE",
    `${label} exceeds the ${maxBytes}-byte limit (${size} bytes)`,
  );
}

function invalidOption(message: string): CodingInstructionsError {
  return new CodingInstructionsError(
    "CODING_INSTRUCTIONS_INVALID_OPTION",
    message,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}
