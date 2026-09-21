import { stripVTControlCharacters } from "node:util";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { RenderResult, RenderSize } from "./component.js";

export interface TextSpan {
  readonly x: number;
  readonly width: number;
  readonly start: number;
  readonly end: number;
}

export interface TextRow {
  readonly sourceId: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly spans: readonly TextSpan[];
}

export interface TextCopyRange {
  readonly start: number;
  readonly end: number;
}

export interface TextDocumentLine {
  readonly value: string;
  /** 未提供时，该行用于界面装饰，不进入复制内容。 */
  readonly copy?: TextCopyRange;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 使用布局时的文字范围连接终端列坐标与复制内容。 */
export function renderTextDocument(
  document: readonly TextDocumentLine[],
  size: RenderSize,
  options: { readonly sourceId?: string; readonly wrap?: boolean } = {},
): RenderResult {
  const source = options.sourceId === undefined ? "" : document.filter(line => line.copy !== undefined)
    .map(line => stripVTControlCharacters(line.value).slice(line.copy!.start, line.copy!.end))
    .join("\n");
  const lines: string[] = [];
  const textRows: Array<TextRow | undefined> = [];
  let sourceOffset = 0;
  for (const line of document) {
    const expanded = expandTabs(line.value);
    const wrapped = options.wrap === false
      ? [sliceAnsi(expanded.value, 0, size.width)]
      : wrapAnsi(expanded.value, size.width, { hard: true, trim: false, wordWrap: true }).split("\n");
    let displayOffset = 0;
    for (const value of wrapped) {
      if (lines.length >= size.height) break;
      lines.push(value);
      const plain = stripVTControlCharacters(value);
      if (line.copy === undefined || options.sourceId === undefined) {
        textRows.push(undefined);
      } else {
        const copy = line.copy;
        const rowDisplayOffset = displayOffset;
        const rowSourceOffset = sourceOffset;
        let spans: readonly TextSpan[] | undefined;
        const start = sourceOffset + Math.max(0, Math.min(line.copy.end - line.copy.start, (expanded.starts?.[displayOffset] ?? displayOffset) - line.copy.start));
        const end = sourceOffset + Math.max(0, Math.min(line.copy.end - line.copy.start, (expanded.ends?.[displayOffset + plain.length] ?? displayOffset + plain.length) - line.copy.start));
        textRows.push({ sourceId: options.sourceId, source, start, end,
          get spans() {
            if (spans !== undefined) return spans;
            const values: TextSpan[] = [];
            let x = 0;
            for (const part of segmenter.segment(plain)) {
              const displayStart = rowDisplayOffset + part.index;
              const displayEnd = displayStart + part.segment.length;
              const partStart = expanded.starts?.[displayStart] ?? displayStart;
              const partEnd = expanded.ends?.[displayEnd] ?? displayEnd;
              const width = stringWidth(part.segment);
              if (partStart >= copy.start && partEnd <= copy.end) {
                const span = { x, width, start: rowSourceOffset + partStart - copy.start,
                  end: rowSourceOffset + partEnd - copy.start };
                const previous = values.at(-1);
                if (previous !== undefined && previous.end === span.end && previous.start === span.start) {
                  values[values.length - 1] = { ...previous, width: previous.width + width };
                } else values.push(span);
              }
              x += width;
            }
            spans = values;
            return spans;
          },
        });
      }
      displayOffset += plain.length;
    }
    if (line.copy !== undefined) sourceOffset += line.copy.end - line.copy.start + 1;
    if (lines.length >= size.height) break;
  }
  return { lines, ...(options.sourceId === undefined ? {} : { textRows }) };
}

function expandTabs(value: string): { value: string; starts?: readonly number[]; ends?: readonly number[] } {
  if (!value.includes("\t")) return { value };
  const plain = stripVTControlCharacters(value);
  const starts = [0];
  const ends = [0];
  for (let index = 0; index < plain.length; index++) {
    if (plain[index] === "\t") { starts.push(index); ends.push(index + 1); }
    starts.push(index + 1);
    ends.push(index + 1);
  }
  return { value: value.replaceAll("\t", "  "), starts, ends };
}

export function textRowOffset(row: TextRow, x: number): number {
  for (const span of row.spans) {
    if (x < span.x + span.width / 2) return span.start;
    if (x < span.x + span.width) return span.end;
  }
  return row.end;
}

export function highlightTextRow(line: string, row: TextRow, start: number, end: number): string {
  if (row.end <= start || row.start >= end) return line;
  const spans = row.spans.filter(span => span.start < end && span.end > start);
  if (spans.length === 0) return line;
  const first = spans[0]!.x;
  const last = spans.at(-1)!;
  const after = last.x + last.width;
  return sliceAnsi(line, 0, first) + "\x1b[7m" + stripVTControlCharacters(sliceAnsi(line, first, after)) + "\x1b[27m" + sliceAnsi(line, after);
}
