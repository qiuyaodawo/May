import type { RenderResult, RenderSize } from "./component.js";
import { ScreenBuffer } from "./screen-buffer.js";

export interface TerminalWriter {
  write(value: string): unknown;
}

export interface FullscreenRendererOptions {
  /** Hide the terminal cursor when a frame does not declare one. */
  readonly hideCursorByDefault?: boolean;
}

/**
 * Renders a retained frame at the top-left of the current terminal screen.
 * Callers should normally pair this with an alternate-screen terminal driver.
 */
export class FullscreenRenderer {
  private previous: ScreenBuffer | undefined;
  private readonly hideCursorByDefault: boolean;

  constructor(
    private readonly terminal: TerminalWriter,
    options: FullscreenRendererOptions = {},
  ) {
    this.hideCursorByDefault = options.hideCursorByDefault ?? true;
  }

  render(result: RenderResult, size: RenderSize): void {
    const next = ScreenBuffer.from(result, size);
    const previous = this.previous;
    const resized = previous !== undefined &&
      (previous.width !== next.width || previous.height !== next.height);
    let output = "\x1b[?25l";

    if (previous === undefined || resized) {
      output += "\x1b[2J";
    }

    const rowCount = previous === undefined || resized
      ? next.lines.length
      : Math.max(next.lines.length, previous.lines.length);
    for (let row = 0; row < rowCount; row++) {
      const line = next.lineAt(row);
      if (!resized && previous?.lineAt(row) === line) continue;
      output += moveTo(row, 0);
      output += `\x1b[2K${line}\x1b[0m`;
    }

    const cursor = next.cursor;
    if (cursor !== undefined) {
      output += moveTo(cursor.y, cursor.x);
      output += cursor.visible === false ? "\x1b[?25l" : "\x1b[?25h";
    } else if (this.hideCursorByDefault) {
      output += "\x1b[?25l";
    } else {
      output += "\x1b[?25h";
    }

    this.terminal.write(output);
    this.previous = next;
  }

  invalidate(): void {
    this.previous = undefined;
  }

  dispose(options: { readonly clear?: boolean } = {}): void {
    this.previous = undefined;
    this.terminal.write(
      `${options.clear === true ? "\x1b[2J\x1b[H" : ""}\x1b[0m\x1b[?25h`,
    );
  }
}

function moveTo(row: number, column: number): string {
  return `\x1b[${row + 1};${column + 1}H`;
}
