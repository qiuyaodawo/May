import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type { CursorPosition, RenderResult, RenderSize } from "./component.js";
import { assertRenderSize } from "./component.js";

export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
  readonly cursor: CursorPosition | undefined;

  private constructor(
    size: RenderSize,
    lines: readonly string[],
    cursor: CursorPosition | undefined,
  ) {
    this.width = size.width;
    this.height = size.height;
    this.lines = lines;
    this.cursor = cursor;
  }

  static from(result: RenderResult, size: RenderSize): ScreenBuffer {
    assertRenderSize(size);
    const lines = result.lines
      .slice(0, size.height)
      .map((line) => normalizeLine(line, size.width));
    const cursor = normalizeCursor(result.cursor, size);
    return new ScreenBuffer(size, lines, cursor);
  }

  lineAt(row: number): string {
    return this.lines[row] ?? "";
  }
}

function normalizeLine(line: string, width: number): string {
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error("A rendered screen line cannot contain a newline");
  }
  return stringWidth(line) <= width ? line : sliceAnsi(line, 0, width);
}

function normalizeCursor(
  cursor: CursorPosition | undefined,
  size: RenderSize,
): CursorPosition | undefined {
  if (cursor === undefined) return undefined;
  const y = clampInteger(cursor.y, 0, Math.max(0, size.height - 1));
  const x = clampInteger(cursor.x, 0, size.width - 1);
  return { x, y, visible: cursor.visible ?? true };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
