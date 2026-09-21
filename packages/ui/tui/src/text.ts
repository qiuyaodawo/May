import { stripVTControlCharacters } from "node:util";
import type { Component, RenderResult, RenderSize } from "./component.js";
import { renderTextDocument, type TextCopyRange } from "./text-selection.js";
import { styleText, type TextStyle } from "./theme.js";

export interface TextOptions {
  readonly wrap?: boolean;
  readonly style?: TextStyle;
  readonly sourceId?: string;
  /** 按逻辑行指定可复制的文字范围，索引使用 UTF-16。 */
  readonly copyRanges?: readonly (TextCopyRange | undefined)[];
}

export class Text implements Component {
  constructor(
    private readonly value: string | (() => string),
    private readonly options: TextOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const value = typeof this.value === "function" ? this.value() : this.value;
    const document = value.split(/\r?\n/u).map((plainLine, index) => {
      const copy = this.options.copyRanges === undefined
        ? { start: 0, end: stripVTControlCharacters(plainLine).length }
        : this.options.copyRanges[index];
      return { value: styleText(plainLine, this.options.style), ...(copy === undefined ? {} : { copy }) };
    });
    return renderTextDocument(document, size, this.options);
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
