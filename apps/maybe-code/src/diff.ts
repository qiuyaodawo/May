import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_DIFF_BODY_LINES = 220;
const CONTEXT_LINES = 3;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type FileChangeKind = "create" | "update" | "no-change";

export type ToolChangePreview =
  | {
      readonly status: "ready";
      readonly tool: "edit" | "write";
      readonly path: string;
      readonly kind: FileChangeKind;
      readonly additions: number;
      readonly deletions: number;
      readonly diff: string;
    }
  | {
      readonly status: "unavailable";
      readonly tool: "edit" | "write";
      readonly path: string;
      readonly reason: string;
    };

export async function createToolChangePreview(
  workspace: string,
  toolName: string,
  input: unknown,
): Promise<ToolChangePreview | undefined> {
  if (toolName !== "edit" && toolName !== "write") return undefined;

  const path = stringField(input, "path") ?? "<unknown>";
  try {
    if (path === "<unknown>") throw new Error("path is missing");
    const file = await resolvePreviewPath(workspace, path);
    const original = file.exists
      ? await readPreviewText(file.absolute, file.relative)
      : undefined;

    let updated: string;
    if (toolName === "write") {
      const content = stringField(input, "content");
      if (content === undefined) throw new Error("content is missing");
      assertPreviewSize(content, "new content");
      updated = content;
    } else {
      if (original === undefined) throw new Error(`file does not exist: ${path}`);
      const oldText = stringField(input, "oldText");
      const newText = stringField(input, "newText");
      if (oldText === undefined || oldText === "") {
        throw new Error("oldText is missing");
      }
      if (newText === undefined) throw new Error("newText is missing");
      const occurrences = countOccurrences(original, oldText, 2);
      if (occurrences === 0) throw new Error("oldText was not found");
      if (occurrences > 1) throw new Error("oldText occurs more than once");
      updated = original.replace(oldText, newText);
      assertPreviewSize(updated, "updated content");
    }

    return createFileChangePreview(
      toolName,
      file.relative,
      original,
      updated,
    );
  } catch (error) {
    return {
      status: "unavailable",
      tool: toolName,
      path,
      reason: errorMessage(error),
    };
  }
}

function createFileChangePreview(
  tool: "edit" | "write",
  path: string,
  original: string | undefined,
  updated: string,
): ToolChangePreview {
  const before = toLines(original ?? "");
  const after = toLines(updated);
  const changes = changedRange(before, after);
  const kind: FileChangeKind = original === undefined
    ? "create"
    : original === updated
    ? "no-change"
    : "update";

  return {
    status: "ready",
    tool,
    path,
    kind,
    additions: changes.additions,
    deletions: changes.deletions,
    diff: kind === "no-change"
      ? ""
      : renderUnifiedDiff(path, original === undefined, before, after, changes),
  };
}

interface PreviewPath {
  readonly absolute: string;
  readonly relative: string;
  readonly exists: boolean;
}

async function resolvePreviewPath(
  workspace: string,
  inputPath: string,
): Promise<PreviewPath> {
  const root = await realpath(resolve(workspace));
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, inputPath);
  const displayPath = display(relative(root, candidate));

  try {
    const target = await realpath(candidate);
    assertInside(root, target, inputPath);
    return { absolute: target, relative: displayPath, exists: true };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { absolute: candidate, relative: displayPath, exists: false };
  }
}

async function readPreviewText(path: string, displayPath: string): Promise<string> {
  const information = await stat(path);
  if (!information.isFile()) throw new Error(`path is not a file: ${displayPath}`);
  if (information.size > MAX_PREVIEW_BYTES) {
    throw new Error(`file exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
  const contents = await readFile(path);
  if (contents.byteLength > MAX_PREVIEW_BYTES) {
    throw new Error(`file exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
  try {
    return UTF8_DECODER.decode(contents);
  } catch {
    throw new Error(`file is not valid UTF-8 text: ${displayPath}`);
  }
}

function assertPreviewSize(text: string, label: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PREVIEW_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
}

interface ChangedRange {
  readonly prefix: number;
  readonly suffix: number;
  readonly additions: number;
  readonly deletions: number;
}

function changedRange(before: readonly string[], after: readonly string[]): ChangedRange {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    prefix,
    suffix,
    deletions: before.length - prefix - suffix,
    additions: after.length - prefix - suffix,
  };
}

function renderUnifiedDiff(
  path: string,
  created: boolean,
  before: readonly string[],
  after: readonly string[],
  change: ChangedRange,
): string {
  const contextBefore = Math.min(CONTEXT_LINES, change.prefix);
  const contextAfter = Math.min(CONTEXT_LINES, change.suffix);
  const oldStart = change.prefix - contextBefore;
  const newStart = change.prefix - contextBefore;
  const oldCount = contextBefore + change.deletions + contextAfter;
  const newCount = contextBefore + change.additions + contextAfter;
  const oldChangedEnd = before.length - change.suffix;
  const newChangedEnd = after.length - change.suffix;
  const body: string[] = [];

  for (let index = oldStart; index < change.prefix; index++) {
    body.push(` ${before[index]}`);
  }
  for (let index = change.prefix; index < oldChangedEnd; index++) {
    body.push(`-${before[index]}`);
  }
  for (let index = change.prefix; index < newChangedEnd; index++) {
    body.push(`+${after[index]}`);
  }
  for (let offset = 0; offset < contextAfter; offset++) {
    body.push(` ${before[oldChangedEnd + offset]}`);
  }

  const visibleBody = truncateBody(body);
  return [
    `--- ${created ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`,
    ...visibleBody,
  ].join("\n");
}

function truncateBody(lines: readonly string[]): string[] {
  if (lines.length <= MAX_DIFF_BODY_LINES) return [...lines];
  const keptAtEachEnd = Math.floor((MAX_DIFF_BODY_LINES - 1) / 2);
  const omitted = lines.length - keptAtEachEnd * 2;
  return [
    ...lines.slice(0, keptAtEachEnd),
    ` … ${omitted} diff lines omitted …`,
    ...lines.slice(-keptAtEachEnd),
  ];
}

function formatRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? String(start + 1) : `${start + 1},${count}`;
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?|\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function countOccurrences(source: string, search: string, stopAt: number): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - search.length) {
    const match = source.indexOf(search, offset);
    if (match === -1) break;
    count += 1;
    if (count >= stopAt) break;
    offset = match + 1;
  }
  return count;
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || !(name in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "string" ? field : undefined;
}

function assertInside(root: string, target: string, inputPath: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`path is outside the workspace: ${inputPath}`);
  }
}

function display(path: string): string {
  return path === "" ? "." : path.split(sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
