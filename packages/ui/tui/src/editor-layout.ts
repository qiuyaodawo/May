import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type { CursorPosition } from "./component.js";
import { styleText, type TextStyle } from "./theme.js";

interface EditorCell {
  readonly index: number;
  readonly x: number;
  readonly width: number;
}

interface EditorRow {
  readonly start: number;
  readonly end: number;
  readonly cells: readonly EditorCell[];
}

export interface EditorLayout {
  readonly lines: readonly string[];
  readonly rows: readonly EditorRow[];
  readonly positions: readonly CursorPosition[];
}

export function layoutEditor(
  graphemes: readonly string[],
  width: number,
  firstPrompt: string,
  continuationPrompt: string,
  selection: readonly [number, number],
  selectionStyle: TextStyle,
): EditorLayout {
  const lines: string[] = [];
  const rows: EditorRow[] = [];
  const positions: CursorPosition[] = [];
  let prompt = fitPrefix(firstPrompt, width);
  let line = prompt;
  let lineWidth = stringWidth(prompt);
  let promptWidth = lineWidth;
  let rowStart = 0;
  let cells: EditorCell[] = [];

  const nextLine = (end: number, start = end): void => {
    lines.push(line);
    rows.push({ start: rowStart, end, cells });
    rowStart = start;
    cells = [];
    prompt = fitPrefix(continuationPrompt, width);
    line = prompt;
    lineWidth = stringWidth(prompt);
    promptWidth = lineWidth;
  };

  for (let index = 0; index < graphemes.length; index++) {
    const grapheme = graphemes[index]!;
    if (grapheme === "\n") {
      positions[index] = { x: Math.min(lineWidth, width - 1), y: lines.length };
      if (index >= selection[0] && index < selection[1] && lineWidth < width) {
        line += styleText(" ", selectionStyle);
      }
      nextLine(index, index + 1);
      continue;
    }
    let displayed = displayGrapheme(grapheme);
    let graphemeWidth = stringWidth(displayed);
    if (lineWidth + graphemeWidth > width && lineWidth > promptWidth) nextLine(index);
    if (lineWidth + graphemeWidth > width) {
      displayed = "�";
      graphemeWidth = 1;
    }
    positions[index] = { x: lineWidth, y: lines.length };
    cells.push({ index, x: lineWidth, width: graphemeWidth });
    line += index >= selection[0] && index < selection[1] ? styleText(displayed, selectionStyle) : displayed;
    lineWidth += graphemeWidth;
  }
  if (lineWidth >= width) nextLine(graphemes.length);
  positions[graphemes.length] = { x: lineWidth, y: lines.length };
  lines.push(line);
  rows.push({ start: rowStart, end: graphemes.length, cells });
  return { lines, rows, positions };
}

export function indexAt(row: EditorRow, column: number): number {
  for (const cell of row.cells) {
    if (column < cell.x + cell.width / 2) return cell.index;
  }
  return row.end;
}

export function indexAtColumn(graphemes: readonly string[], start: number, end: number, column: number): number {
  let width = 0;
  for (let index = start; index < end; index++) {
    const next = stringWidth(displayGrapheme(graphemes[index]!));
    if (column < width + next / 2) return index;
    width += next;
  }
  return end;
}

export function fitPrefix(value: string, width: number): string {
  if (width <= 1) return "";
  return sliceAnsi(value.replace(/[\r\n]/gu, ""), 0, width - 1);
}

export function displayGrapheme(value: string): string {
  if (value === "\t") return "  ";
  if (/^[\u0000-\u001f\u007f-\u009f]$/u.test(value)) return "�";
  return value;
}
