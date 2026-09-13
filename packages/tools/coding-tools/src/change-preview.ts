import { readFile, stat } from "node:fs/promises";
import { resolveWritableWorkspacePath } from "./workspace-path.js";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_LINES = 20_000;
const MAX_PREVIEW_LINE_BYTES = 64 * 1024;
const MAX_DIFF_BODY_LINES = 220;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_DIFF_LINE_BYTES = 4 * 1024;
const MAX_EXACT_EDIT_DISTANCE = 512;
const CONTEXT_LINES = 3;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

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

/**
 * Stable presentation identifier for persisted coding-tool previews.
 *
 * The wire value intentionally retains its original identifier so sessions
 * created by earlier MaybeCode versions remain replayable after this component
 * moved into `@may/coding-tools`.
 */
export const TOOL_CHANGE_PREVIEW_PRESENTATION_KIND = "maybecode.change-preview";
export const TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION = 1;

/** @deprecated Use `TOOL_CHANGE_PREVIEW_PRESENTATION_KIND`. */
export const MAYBECODE_CHANGE_PREVIEW_PRESENTATION_KIND =
  TOOL_CHANGE_PREVIEW_PRESENTATION_KIND;
/** @deprecated Use `TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION`. */
export const MAYBECODE_CHANGE_PREVIEW_PRESENTATION_VERSION =
  TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION;

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
      updated = original.replace(oldText, () => newText);
      assertPreviewSize(updated, "updated content");
    }

    assertTextShape(updated, "updated content");

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
  const operations = diffLines(before, after);
  const additions = operations.filter((operation) =>
    operation.type === "add"
  ).length;
  const deletions = operations.filter((operation) =>
    operation.type === "delete"
  ).length;
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
    additions,
    deletions,
    diff: kind === "no-change"
      ? ""
      : renderUnifiedDiff(path, original === undefined, operations),
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
    if (
      Buffer.byteLength(text.slice(lineStart, index), "utf8") >
        MAX_PREVIEW_LINE_BYTES
    ) {
      throw new Error(
        `${label} contains a line exceeding the ${MAX_PREVIEW_LINE_BYTES} byte limit`,
      );
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

type DiffOperation =
  | { readonly type: "equal"; readonly line: string }
  | { readonly type: "add"; readonly line: string }
  | { readonly type: "delete"; readonly line: string };

function renderUnifiedDiff(
  path: string,
  created: boolean,
  operations: readonly DiffOperation[],
): string {
  const records = positionOperations(operations);
  const changed = records.flatMap((record, index) =>
    record.operation.type === "equal" ? [] : [index]
  );
  const hunks: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(records.length, index + CONTEXT_LINES + 1);
    const previous = hunks.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const body: string[] = [];
  for (const hunk of hunks) {
    const first = records[hunk.start]!;
    const slice = records.slice(hunk.start, hunk.end);
    const oldCount = slice.filter((record) => record.operation.type !== "add").length;
    const newCount = slice.filter((record) => record.operation.type !== "delete").length;
    body.push(
      `@@ -${formatRange(first.oldBefore, oldCount)} ` +
        `+${formatRange(first.newBefore, newCount)} @@`,
    );
    for (const record of slice) {
      const prefix = record.operation.type === "equal"
        ? " "
        : record.operation.type === "add"
        ? "+"
        : "-";
      const line = decodeDiffLine(record.operation.line);
      body.push(limitDiffLine(`${prefix}${renderDiffText(line.text)}`));
      if (record.operation.type !== "equal") {
        if (line.ending === "none") {
          body.push("\\ No newline at end of file");
        } else if (line.ending !== "lf") {
          body.push(`\\ Line ending: ${line.ending.toUpperCase()}`);
        }
      }
    }
  }

  return limitDiff([
    `--- ${created ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    ...truncateBody(body),
  ]);
}

function diffLines(
  before: readonly string[],
  after: readonly string[],
): DiffOperation[] {
  const exact = myersDiff(before, after);
  if (exact !== undefined) return exact;

  // Bound worst-case time and memory while still preserving separated edits:
  // patience anchors divide large changes into independently diffable blocks.
  return patienceDiff(before, after);
}

function patienceDiff(
  before: readonly string[],
  after: readonly string[],
): DiffOperation[] {
  const output: DiffOperation[] = [];
  diffPatienceRange(before, 0, before.length, after, 0, after.length, output);
  return output;
}

function diffPatienceRange(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
  output: DiffOperation[],
): void {
  while (
    beforeStart < beforeEnd && afterStart < afterEnd &&
    before[beforeStart] === after[afterStart]
  ) {
    output.push({ type: "equal", line: before[beforeStart]! });
    beforeStart += 1;
    afterStart += 1;
  }
  let suffix = 0;
  while (
    beforeStart < beforeEnd - suffix && afterStart < afterEnd - suffix &&
    before[beforeEnd - suffix - 1] === after[afterEnd - suffix - 1]
  ) suffix += 1;
  const middleBeforeEnd = beforeEnd - suffix;
  const middleAfterEnd = afterEnd - suffix;

  if (beforeStart === middleBeforeEnd) {
    for (let index = afterStart; index < middleAfterEnd; index++) {
      output.push({ type: "add", line: after[index]! });
    }
  } else if (afterStart === middleAfterEnd) {
    for (let index = beforeStart; index < middleBeforeEnd; index++) {
      output.push({ type: "delete", line: before[index]! });
    }
  } else {
    const exact = myersDiff(
      before.slice(beforeStart, middleBeforeEnd),
      after.slice(afterStart, middleAfterEnd),
    );
    if (exact !== undefined) {
      output.push(...exact);
    } else {
      const anchors = patienceAnchors(
        before,
        beforeStart,
        middleBeforeEnd,
        after,
        afterStart,
        middleAfterEnd,
      );
      if (anchors.length === 0) {
        for (let index = beforeStart; index < middleBeforeEnd; index++) {
          output.push({ type: "delete", line: before[index]! });
        }
        for (let index = afterStart; index < middleAfterEnd; index++) {
          output.push({ type: "add", line: after[index]! });
        }
      } else {
        let previousBefore = beforeStart;
        let previousAfter = afterStart;
        for (const anchor of anchors) {
          diffPatienceRange(
            before,
            previousBefore,
            anchor.before,
            after,
            previousAfter,
            anchor.after,
            output,
          );
          output.push({ type: "equal", line: before[anchor.before]! });
          previousBefore = anchor.before + 1;
          previousAfter = anchor.after + 1;
        }
        diffPatienceRange(
          before,
          previousBefore,
          middleBeforeEnd,
          after,
          previousAfter,
          middleAfterEnd,
          output,
        );
      }
    }
  }
  for (let offset = suffix; offset > 0; offset--) {
    output.push({ type: "equal", line: before[beforeEnd - offset]! });
  }
}

interface PatienceAnchor {
  readonly before: number;
  readonly after: number;
}

function patienceAnchors(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
): PatienceAnchor[] {
  const beforeLines = uniqueLinePositions(before, beforeStart, beforeEnd);
  const afterLines = uniqueLinePositions(after, afterStart, afterEnd);
  const candidates: PatienceAnchor[] = [];
  for (const [line, position] of beforeLines) {
    if (position.count !== 1) continue;
    const matching = afterLines.get(line);
    if (matching?.count === 1) {
      candidates.push({ before: position.index, after: matching.index });
    }
  }
  candidates.sort((left, right) => left.before - right.before);
  if (candidates.length < 2) return candidates;

  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (const [index, candidate] of candidates.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle]! < candidate.after) low = middle + 1;
      else high = middle;
    }
    tails[low] = candidate.after;
    previous[index] = low === 0 ? -1 : tailIndices[low - 1]!;
    tailIndices[low] = index;
  }
  const anchors: PatienceAnchor[] = [];
  let index = tailIndices[tails.length - 1]!;
  while (index >= 0) {
    anchors.push(candidates[index]!);
    index = previous[index]!;
  }
  return anchors.reverse();
}

function uniqueLinePositions(
  lines: readonly string[],
  start: number,
  end: number,
): Map<string, { count: number; index: number }> {
  const positions = new Map<string, { count: number; index: number }>();
  for (let index = start; index < end; index++) {
    const line = lines[index]!;
    const current = positions.get(line);
    positions.set(line, {
      count: (current?.count ?? 0) + 1,
      index: current?.index ?? index,
    });
  }
  return positions;
}

function myersDiff(
  before: readonly string[],
  after: readonly string[],
): DiffOperation[] | undefined {
  const maximum = before.length + after.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (
    let distance = 0;
    distance <= Math.min(maximum, MAX_EXACT_EDIT_DISTANCE);
    distance++
  ) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const fromAdd = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -distance ||
          (diagonal !== distance && fromDelete < fromAdd)
        ? Math.max(0, fromAdd)
        : Math.max(0, fromDelete + 1);
      let y = x - diagonal;
      while (
        x < before.length && y < after.length && before[x] === after[y]
      ) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrackMyers(before, after, trace, distance);
      }
    }
  }
  return undefined;
}

function backtrackMyers(
  before: readonly string[],
  after: readonly string[],
  trace: readonly Map<number, number>[],
  finalDistance: number,
): DiffOperation[] {
  let x = before.length;
  let y = after.length;
  const reversed: DiffOperation[] = [];
  for (let distance = finalDistance; distance >= 0; distance--) {
    const frontier = trace[distance]!;
    const diagonal = x - y;
    const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const fromAdd = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance ||
        (diagonal !== distance && fromDelete < fromAdd)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ type: "equal", line: before[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      reversed.push({ type: "add", line: after[y - 1]! });
      y -= 1;
    } else {
      reversed.push({ type: "delete", line: before[x - 1]! });
      x -= 1;
    }
  }
  return reversed.reverse();
}

interface PositionedOperation {
  readonly operation: DiffOperation;
  readonly oldBefore: number;
  readonly newBefore: number;
}

function positionOperations(
  operations: readonly DiffOperation[],
): PositionedOperation[] {
  let oldBefore = 0;
  let newBefore = 0;
  return operations.map((operation) => {
    const positioned = { operation, oldBefore, newBefore };
    if (operation.type !== "add") oldBefore += 1;
    if (operation.type !== "delete") newBefore += 1;
    return positioned;
  });
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

function limitDiffLine(line: string): string {
  return truncateUtf8(line, MAX_DIFF_LINE_BYTES);
}

function limitDiff(lines: readonly string[]): string {
  const visible: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const next = bytes + Buffer.byteLength(line, "utf8") +
      (visible.length === 0 ? 0 : 1);
    if (next > MAX_DIFF_BYTES) {
      const separatorBytes = visible.length === 0 ? 0 : 1;
      const remaining = MAX_DIFF_BYTES - bytes - separatorBytes;
      if (remaining > 0) {
        visible.push(truncateUtf8("… diff byte limit reached …", remaining));
      }
      break;
    }
    visible.push(line);
    bytes = next;
  }
  return visible.join("\n");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maximumBytes < suffixBytes) return "";
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffixBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

function formatRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? String(start + 1) : `${start + 1},${count}`;
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  const endings = /\r\n|\r|\n/gu;
  let start = 0;
  for (const match of text.matchAll(endings)) {
    const ending = match[0] === "\r\n"
      ? "crlf"
      : match[0] === "\r"
      ? "cr"
      : "lf";
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
  return text.startsWith("\uFEFF")
    ? `⟦UTF-8 BOM⟧${text.slice(1)}`
    : text;
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
  if (
    (preview.tool !== "edit" && preview.tool !== "write") ||
    typeof preview.path !== "string"
  ) {
    return false;
  }
  if (preview.status === "unavailable") {
    return typeof preview.reason === "string";
  }
  return preview.status === "ready" &&
    (preview.kind === "create" ||
      preview.kind === "update" ||
      preview.kind === "no-change") &&
    isNonNegativeInteger(preview.additions) &&
    isNonNegativeInteger(preview.deletions) &&
    typeof preview.diff === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
