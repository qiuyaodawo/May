import { readFile, stat } from "node:fs/promises";
import { diffLines } from "./line-diff.js";
import { isMissingPathError } from "./missing-path.js";
import { renderUnifiedDiff } from "./unified-diff.js";
import { resolveWritableWorkspacePath } from "./workspace-path.js";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_LINES = 20_000;
const MAX_PREVIEW_LINE_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/** @experimental */
export type FileChangeKind = "create" | "update" | "no-change";

/** @experimental */
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

/**
 * Stable presentation identifier for persisted coding-tool previews.
 *
 * The wire value intentionally retains its original identifier so sessions
 * created by earlier MaybeCode versions remain replayable after this component
 * moved into `@sortedyuan/coding-tools`.
 * @experimental
 */
export const TOOL_CHANGE_PREVIEW_PRESENTATION_KIND = "maybecode.change-preview";
/** @experimental */
export const TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION = 1;

/**
 * @deprecated Use `TOOL_CHANGE_PREVIEW_PRESENTATION_KIND`.
 * @experimental
 */
export const MAYBECODE_CHANGE_PREVIEW_PRESENTATION_KIND = TOOL_CHANGE_PREVIEW_PRESENTATION_KIND;
/**
 * @deprecated Use `TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION`.
 * @experimental
 */
export const MAYBECODE_CHANGE_PREVIEW_PRESENTATION_VERSION = TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION;

/** @experimental */
export function decodeToolChangePreviewPresentation(
  kind: string,
  version: number,
  data: unknown,
): ToolChangePreview | undefined {
  if (
    kind !== TOOL_CHANGE_PREVIEW_PRESENTATION_KIND ||
    version !== TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION ||
    !isToolChangePreview(data)
  ) {
    return undefined;
  }
  return data;
}

/** @experimental */
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
    const original = file.exists ? await readPreviewText(file.absolute, file.relative) : undefined;

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
      updated = original.replace(oldText, () => newText);
      assertPreviewSize(updated, "updated content");
    }

    assertTextShape(updated, "updated content");

    return createTextChangePreview(toolName, file.relative, original, updated);
  } catch (error) {
    return {
      status: "unavailable",
      tool: toolName,
      path,
      reason: errorMessage(error),
    };
  }
}

/** @experimental */
export function createTextChangePreview(
  tool: "edit" | "write",
  path: string,
  original: string | undefined,
  updated: string,
): ToolChangePreview {
  if (original !== undefined) {
    assertPreviewSize(original, "original content");
    assertTextShape(original, "original content");
  }
  assertPreviewSize(updated, "updated content");
  assertTextShape(updated, "updated content");
  const before = toLines(original ?? "");
  const after = toLines(updated);
  const operations = diffLines(before, after);
  const additions = operations.filter((operation) => operation.type === "add").length;
  const deletions = operations.filter((operation) => operation.type === "delete").length;
  const kind: FileChangeKind = original === undefined ? "create" : original === updated ? "no-change" : "update";

  return {
    status: "ready",
    tool,
    path,
    kind,
    additions,
    deletions,
    diff: kind === "no-change" ? "" : renderUnifiedDiff(path, original === undefined, operations),
  };
}

interface PreviewPath {
  readonly absolute: string;
  readonly relative: string;
  readonly exists: boolean;
}

async function resolvePreviewPath(workspace: string, inputPath: string): Promise<PreviewPath> {
  const file = await resolveWritableWorkspacePath(workspace, inputPath);
  try {
    await stat(file.absolute);
    return { ...file, exists: true };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { ...file, exists: false };
  }
}

async function readPreviewText(path: string, displayPath: string): Promise<string> {
  const information = await stat(path);
  if (!information.isFile()) throw new Error(`path is not a file: ${displayPath}`);
  if (information.nlink > 1) {
    throw new Error(`hard-linked files cannot be previewed: ${displayPath}`);
  }
  if (information.size > MAX_PREVIEW_BYTES) {
    throw new Error(`file exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
  const contents = await readFile(path);
  if (contents.byteLength > MAX_PREVIEW_BYTES) {
    throw new Error(`file exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(contents);
  } catch {
    throw new Error(`file is not valid UTF-8 text: ${displayPath}`);
  }
  assertTextShape(text, `file ${displayPath}`);
  return text;
}

function assertTextShape(text: string, label: string): void {
  let lines = 1;
  let lineStart = 0;
  for (let index = 0; index <= text.length; index++) {
    const character = text[index];
    if (index !== text.length && character !== "\n" && character !== "\r") {
      continue;
    }
    if (Buffer.byteLength(text.slice(lineStart, index), "utf8") > MAX_PREVIEW_LINE_BYTES) {
      throw new Error(`${label} contains a line exceeding the ${MAX_PREVIEW_LINE_BYTES} byte limit`);
    }
    if (character === "\r" && text[index + 1] === "\n") index += 1;
    lineStart = index + 1;
    if (lineStart <= text.length) lines += 1;
    if (lines > MAX_PREVIEW_LINES) {
      throw new Error(`${label} exceeds the ${MAX_PREVIEW_LINES} line limit`);
    }
  }
}

function assertPreviewSize(text: string, label: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PREVIEW_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`);
  }
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  const endings = /\r\n|\r|\n/gu;
  let start = 0;
  for (const match of text.matchAll(endings)) {
    const ending = match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf";
    lines.push(JSON.stringify([text.slice(start, match.index), ending]));
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    lines.push(JSON.stringify([text.slice(start), "none"]));
  }
  return lines;
}

function decodeDiffLine(line: string): {
  readonly text: string;
  readonly ending: "lf" | "crlf" | "cr" | "none";
} {
  const value = JSON.parse(line) as [string, "lf" | "crlf" | "cr" | "none"];
  return { text: value[0], ending: value[1] };
}

function renderDiffText(text: string): string {
  return text.startsWith("\uFEFF") ? `⟦UTF-8 BOM⟧${text.slice(1)}` : text;
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

function isToolChangePreview(value: unknown): value is ToolChangePreview {
  if (typeof value !== "object" || value === null) return false;
  const preview = value as Record<string, unknown>;
  if ((preview.tool !== "edit" && preview.tool !== "write") || typeof preview.path !== "string") {
    return false;
  }
  if (preview.status === "unavailable") {
    return typeof preview.reason === "string";
  }
  return (
    preview.status === "ready" &&
    (preview.kind === "create" || preview.kind === "update" || preview.kind === "no-change") &&
    isNonNegativeInteger(preview.additions) &&
    isNonNegativeInteger(preview.deletions) &&
    typeof preview.diff === "string"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
