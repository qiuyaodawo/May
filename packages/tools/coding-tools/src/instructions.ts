import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { shellRuntimeInstructions, type ShellToolInfo } from "./shell.js";

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
  /** 按项目根目录到 workspace 排列的完整规则列表。 */
  readonly projects: readonly CodingInstructionDocument[];
  /** 最近目录的一份规则；完整组合使用 projects 或 effective。 */
  readonly project?: CodingInstructionDocument;
  readonly effective: string;
}

export interface CodingRuntimeInstructionsOptions {
  readonly workspace: string;
  readonly shell?: ShellToolInfo;
  readonly agentRole?: "main agent" | "sub-agent";
  readonly sessionOrigin?: "new session" | "resumed session" | "historical branch";
  readonly permissionMode?: string;
  readonly assignedRole?: string;
  readonly parentTask?: string;
  readonly historicalSource?: string;
}

export function codingRuntimeInstructions(
  options: Readonly<CodingRuntimeInstructionsOptions>,
): string {
  if (options.workspace.trim() === "") {
    throw invalidOption("workspace must not be empty");
  }
  const operatingSystem = process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin"
    ? "macOS"
    : process.platform === "linux"
    ? "Linux"
    : process.platform;
  const sessionOrigin = options.sessionOrigin ?? "new session";
  const lines = [
    `Workspace: ${resolve(options.workspace)}`,
    `Operating system: ${operatingSystem}`,
    ...(options.shell === undefined ? [] : [`Shell: ${options.shell.displayName}`]),
    `Agent role: ${options.agentRole ?? "main agent"}`,
    `Session origin: ${sessionOrigin}`,
  ];
  if (options.permissionMode !== undefined) {
    lines.push(`Permission mode: ${options.permissionMode}`);
  }
  if (options.assignedRole !== undefined) {
    lines.push(`Assigned role: ${options.assignedRole}`);
  }
  if (options.parentTask !== undefined) {
    lines.push(`Parent task: ${options.parentTask}`);
  }
  if (options.historicalSource !== undefined) {
    lines.push(`Source session: ${options.historicalSource}`);
  }
  const sections = [lines.join("\n")];
  if (sessionOrigin === "historical branch") {
    sections.push(
      "The conversation begins from a historical point.\n" +
        "Workspace files may have changed since that point.\n" +
        "Read current files before relying on historical file contents.",
    );
  }
  if (options.shell !== undefined) {
    sections.push(shellRuntimeInstructions(options.shell));
  }
  return sections.join("\n\n");
}

export interface LoadCodingInstructionsOptions {
  /** 启动目录，也是项目规则搜索的终点。 */
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
  /** 各目录中的规则文件名；false 禁用整条项目规则链。 */
  readonly projectInstructionsFilename?: string | false;
  /** 在规则文件缺失或为空时继续检查的文件名。 */
  readonly projectInstructionsFallbackFilenames?: readonly string[];
  /** 项目根目录标记，默认 [".git"]；空列表只检查 workspace。 */
  readonly projectRootMarkers?: readonly string[];
  /** Markdown section labels used to assemble `effective`. */
  readonly sectionLabels?: Partial<CodingInstructionSectionLabels>;
  /** 单文档及项目规则正文组合的 UTF-8 字节上限。 */
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
 * 组合 system、runtime 和项目根目录到 workspace 的规则。
 * 文件使用有大小限制的 strict UTF-8，并拒绝不安全链接。
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
  const projects = settings.projectFilename === false
    ? []
    : await loadProjectInstructions(workspace, settings, options.signal);
  const project = projects.at(-1);

  const sections = [system.content];
  if (runtime !== undefined) {
    sections.push(`# ${settings.labels.runtime}\n\n${runtime.content}`);
  }
  const projectSection = formatCodingProjectInstructions(projects, settings.labels.project);
  if (projectSection !== "") sections.push(projectSection);

  return {
    system,
    projects,
    ...(runtime === undefined ? {} : { runtime }),
    ...(project === undefined ? {} : { project }),
    effective: sections.join("\n\n"),
  };
}

export function formatCodingProjectInstructions(
  projects: readonly CodingInstructionDocument[],
  label = DEFAULT_CODING_INSTRUCTION_SECTION_LABELS.project,
): string {
  sectionLabel(label, "label");
  if (projects.length === 0) return "";
  const sections = [`# ${label}`];
  if (projects.length > 1) {
    sections.push(
      "Each document applies to its directory and descendants.\n" +
        "For conflicting rules, the document in the deeper directory takes precedence.",
    );
  }
  for (const project of projects) {
    const source = project.source.type === "file"
      ? `Source: ${project.source.path}\n` +
        (projects.length > 1 ? `Scope: ${dirname(project.source.path)}\n` : "") + "\n"
      : "";
    sections.push(`${source}${project.content}`);
  }
  return sections.join("\n\n");
}

interface ValidatedOptions {
  readonly maxBytes: number;
  readonly systemFilename: string;
  readonly projectFilename: string | false;
  readonly projectFallbackFilenames: readonly string[];
  readonly projectRootMarkers: readonly string[];
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
  const projectFallbackFilenames = instructionFilenames(
    options.projectInstructionsFallbackFilenames ?? [],
    "projectInstructionsFallbackFilenames",
  );
  const projectRootMarkers = instructionFilenames(
    options.projectRootMarkers ?? [".git"],
    "projectRootMarkers",
  );
  return { maxBytes, systemFilename, projectFilename, projectFallbackFilenames, projectRootMarkers, labels };
}

function instructionFilenames(values: readonly string[], option: string): readonly string[] {
  if (!Array.isArray(values)) throw invalidOption(`${option} must be an array of filenames`);
  return [...new Set(values.map(value => {
    if (typeof value !== "string") throw invalidOption(`${option} must contain filenames`);
    return instructionFilename(value, option);
  }))];
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

async function loadProjectInstructions(
  workspace: string,
  settings: ValidatedOptions,
  signal: AbortSignal | undefined,
): Promise<readonly CodingInstructionDocument[]> {
  const directories = [workspace];
  if (settings.projectRootMarkers.length > 0) {
    let current = workspace;
    while (!await hasProjectRootMarker(current, settings.projectRootMarkers, signal)) {
      const parent = dirname(current);
      if (parent === current) {
        directories.splice(1);
        break;
      }
      directories.push(parent);
      current = parent;
    }
  }
  const filenames = [...new Set([
    "AGENTS.override.md",
    ...(settings.projectFilename === false ? [] : [settings.projectFilename]),
    ...settings.projectFallbackFilenames,
  ])];
  const documents: CodingInstructionDocument[] = [];
  let bytes = 0;
  for (const directory of directories.reverse()) {
    for (const filename of filenames) {
      const document = await loadOptionalProjectFile(directory, filename, settings.maxBytes, signal);
      if (document === undefined) continue;
      bytes += Buffer.byteLength(document.content, "utf8") + (documents.length === 0 ? 0 : 2);
      assertSize(bytes, "Combined project instructions", settings.maxBytes);
      documents.push(document);
      break;
    }
  }
  return documents;
}

async function hasProjectRootMarker(
  directory: string,
  markers: readonly string[],
  signal: AbortSignal | undefined,
): Promise<boolean> {
  for (const marker of markers) {
    throwIfAborted(signal);
    try {
      await lstat(resolve(directory, marker));
      return true;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw new CodingInstructionsError(
        "CODING_INSTRUCTIONS_READ_FAILED",
        `Unable to inspect project root marker: ${resolve(directory, marker)}`,
        { cause: error },
      );
    }
  }
  return false;
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
