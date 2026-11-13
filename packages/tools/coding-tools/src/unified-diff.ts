import type { DiffOperation } from "./line-diff.js";

const MAX_DIFF_BODY_LINES = 220;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_DIFF_LINE_BYTES = 4 * 1024;
const CONTEXT_LINES = 3;

export function renderUnifiedDiff(path: string, created: boolean, operations: readonly DiffOperation[]): string {
  const records = positionOperations(operations);
  const changed = records.flatMap((record, index) => (record.operation.type === "equal" ? [] : [index]));
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
    body.push(`@@ -${formatRange(first.oldBefore, oldCount)} ` + `+${formatRange(first.newBefore, newCount)} @@`);
    for (const record of slice) {
      const prefix = record.operation.type === "equal" ? " " : record.operation.type === "add" ? "+" : "-";
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

  return limitDiff([`--- ${created ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`, ...truncateBody(body)]);
}

interface PositionedOperation {
  readonly operation: DiffOperation;
  readonly oldBefore: number;
  readonly newBefore: number;
}

function positionOperations(operations: readonly DiffOperation[]): PositionedOperation[] {
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
  return [...lines.slice(0, keptAtEachEnd), ` … ${omitted} diff lines omitted …`, ...lines.slice(-keptAtEachEnd)];
}

function limitDiffLine(line: string): string {
  return truncateUtf8(line, MAX_DIFF_LINE_BYTES);
}

function limitDiff(lines: readonly string[]): string {
  const visible: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const next = bytes + Buffer.byteLength(line, "utf8") + (visible.length === 0 ? 0 : 1);
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

function decodeDiffLine(line: string): {
  readonly text: string;
  readonly ending: "lf" | "crlf" | "cr" | "none";
} {
  const value = JSON.parse(line) as [string, "lf" | "crlf" | "cr" | "none"];
  return { text: value[0], ending: value[1] };
}

function renderDiffText(text: string): string {
  return text.startsWith("﻿") ? `⟦UTF-8 BOM⟧${text.slice(1)}` : text;
}
