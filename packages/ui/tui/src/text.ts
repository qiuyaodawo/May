import sliceAnsi from "slice-ansi";
import wrapAnsi from "wrap-ansi";
import type { Component, RenderResult, RenderSize } from "./component.js";
import { styleText, type TextStyle } from "./theme.js";

export interface TextOptions {
  readonly wrap?: boolean;
  readonly style?: TextStyle;
}

export class Text implements Component {
  constructor(
    private readonly value: string | (() => string),
    private readonly options: TextOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const value = typeof this.value === "function" ? this.value() : this.value;
    const lines = value.split(/\r?\n/u).flatMap((plainLine) => {
      const line = styleText(plainLine, this.options.style);
      if (this.options.wrap === false) return [sliceAnsi(line, 0, size.width)];
      const wrapped = wrapAnsi(line, size.width, {
        hard: true,
        trim: false,
        wordWrap: true,
      });
      return wrapped === "" ? [""] : wrapped.split("\n");
    });
    return { lines: lines.slice(0, size.height) };
  }
}

/** Neutralize terminal control sequences in model, tool, or user supplied text. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u001b/gu, "␛")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/gu,
      "�",
    );
}
