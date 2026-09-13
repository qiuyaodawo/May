import type { KeyStroke } from "@may/keybindings";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type {
  CursorPosition,
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "./component.js";
import { styleText, type TextStyle } from "./theme.js";

export interface EditorOptions {
  readonly value?: string;
  readonly prompt?: string;
  readonly continuationPrompt?: string;
  readonly placeholder?: string;
  readonly promptStyle?: TextStyle;
  readonly placeholderStyle?: TextStyle;
  readonly history?: EditorHistory;
  readonly onChange?: (value: string) => void;
  /** When omitted, Enter inserts a newline. Shift+Enter always inserts one. */
  readonly onSubmit?: (value: string) => void;
}

export interface EditorHistoryOptions {
  readonly entries?: readonly string[];
  readonly maximumEntries?: number;
}

/** In-process command history that can be shared with or replaced by a UI. */
export class EditorHistory {
  private readonly maximumEntries: number;
  private entries: string[];
  private index: number;
  private draft = "";

  constructor(options: EditorHistoryOptions = {}) {
    this.maximumEntries = positiveInteger(
      options.maximumEntries ?? 100,
      "maximumEntries",
    );
    this.entries = (options.entries ?? [])
      .map(normalizeValue)
      .filter((value) => value.trim() !== "")
      .slice(-this.maximumEntries);
    this.index = this.entries.length;
  }

  get values(): readonly string[] {
    return [...this.entries];
  }

  record(value: string): void {
    const normalized = normalizeValue(value);
    if (
      normalized.trim() !== "" &&
      this.entries.at(-1) !== normalized
    ) {
      this.entries.push(normalized);
      if (this.entries.length > this.maximumEntries) {
        this.entries.splice(0, this.entries.length - this.maximumEntries);
      }
    }
    this.reset();
  }

  previous(current: string): string | undefined {
    if (this.entries.length === 0 || this.index === 0) return undefined;
    if (this.index === this.entries.length) this.draft = current;
    this.index -= 1;
    return this.entries[this.index];
  }

  next(): string | undefined {
    if (this.index >= this.entries.length) return undefined;
    this.index += 1;
    return this.index === this.entries.length
      ? this.draft
      : this.entries[this.index];
  }

  reset(): void {
    this.index = this.entries.length;
    this.draft = "";
  }
}

export class Editor implements InteractiveComponent, FocusTarget {
  private graphemes: string[];
  private cursorIndex: number;
  private focused = false;
  private readonly prompt: string;
  private readonly continuationPrompt: string;

  constructor(private readonly options: EditorOptions = {}) {
    this.graphemes = segment(normalizeValue(options.value ?? ""));
    this.cursorIndex = this.graphemes.length;
    this.prompt = styleText(options.prompt ?? "> ", options.promptStyle);
    this.continuationPrompt = styleText(
      options.continuationPrompt ?? "  ",
      options.promptStyle,
    );
  }

  get value(): string {
    return this.graphemes.join("");
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  setValue(value: string, cursor = segment(normalizeValue(value)).length): void {
    this.graphemes = segment(normalizeValue(value));
    this.cursorIndex = clamp(cursor, 0, this.graphemes.length);
    this.options.history?.reset();
    this.changed();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused) return false;
    if (stroke.ctrl && stroke.key === "a") return this.moveToLineStart();
    if (stroke.ctrl && stroke.key === "e") return this.moveToLineEnd();
    if (
      (stroke.ctrl && stroke.key === "w") ||
      ((stroke.ctrl || stroke.alt) && stroke.key === "backspace")
    ) {
      return this.deleteWordBackward();
    }
    if ((stroke.ctrl || stroke.alt) && stroke.key === "left") {
      return this.moveWord(-1);
    }
    if ((stroke.ctrl || stroke.alt) && stroke.key === "right") {
      return this.moveWord(1);
    }

    switch (stroke.key) {
      case "left":
        return this.moveCursor(-1);
      case "right":
        return this.moveCursor(1);
      case "up":
        return this.moveVertical(-1) || this.navigateHistory(-1);
      case "down":
        return this.moveVertical(1) || this.navigateHistory(1);
      case "home":
        return this.moveToLineStart();
      case "end":
        return this.moveToLineEnd();
      case "backspace":
        return this.backspace();
      case "delete":
        return this.deleteForward();
      case "enter":
        if (this.options.onSubmit !== undefined && !stroke.shift) {
          const value = this.value;
          this.options.history?.record(value);
          this.options.onSubmit(value);
          return true;
        }
        return this.insert("\n");
      case "paste":
        return stroke.text === undefined ? false : this.insert(stroke.text);
      case "tab":
        return this.insert("\t");
      default:
        if (stroke.text !== undefined && !stroke.ctrl && !stroke.alt && !stroke.meta) {
          return this.insert(stroke.text);
        }
        return false;
    }
  }

  render(size: RenderSize): RenderResult {
    const rendered = renderEditor(
      this.graphemes,
      this.cursorIndex,
      size.width,
      this.prompt,
      this.continuationPrompt,
    );
    let lines = rendered.lines;
    let cursor = rendered.cursor;
    if (this.graphemes.length === 0 && this.options.placeholder !== undefined) {
      const prefix = fitPrefix(this.prompt, size.width);
      lines = [sliceAnsi(
        `${prefix}${styleText(this.options.placeholder.replace(/[\r\n]+/gu, " "), this.options.placeholderStyle)}`,
        0,
        size.width,
      )];
      cursor = { x: stringWidth(prefix), y: 0 };
    }

    const start = Math.max(0, cursor.y - size.height + 1);
    const visibleLines = lines.slice(start, start + size.height);
    return {
      lines: visibleLines,
      cursor: {
        x: cursor.x,
        y: cursor.y - start,
        visible: this.focused,
      },
    };
  }

  private insert(value: string): boolean {
    const inserted = segment(normalizeValue(value));
    if (inserted.length === 0) return false;
    this.graphemes.splice(this.cursorIndex, 0, ...inserted);
    this.cursorIndex += inserted.length;
    this.changed();
    return true;
  }

  private backspace(): boolean {
    if (this.cursorIndex === 0) return false;
    this.graphemes.splice(this.cursorIndex - 1, 1);
    this.cursorIndex -= 1;
    this.changed();
    return true;
  }

  private deleteForward(): boolean {
    if (this.cursorIndex >= this.graphemes.length) return false;
    this.graphemes.splice(this.cursorIndex, 1);
    this.changed();
    return true;
  }

  private moveCursor(offset: number): boolean {
    const next = clamp(this.cursorIndex + offset, 0, this.graphemes.length);
    if (next === this.cursorIndex) return false;
    this.cursorIndex = next;
    return true;
  }

  private moveToLineStart(): boolean {
    const next = lineStart(this.graphemes, this.cursorIndex);
    if (next === this.cursorIndex) return false;
    this.cursorIndex = next;
    return true;
  }

  private moveToLineEnd(): boolean {
    const next = lineEnd(this.graphemes, this.cursorIndex);
    if (next === this.cursorIndex) return false;
    this.cursorIndex = next;
    return true;
  }

  private moveVertical(direction: -1 | 1): boolean {
    const start = lineStart(this.graphemes, this.cursorIndex);
    const column = this.cursorIndex - start;
    if (direction < 0) {
      if (start === 0) return false;
      const previousEnd = start - 1;
      const previousStart = lineStart(this.graphemes, previousEnd);
      this.cursorIndex = Math.min(previousStart + column, previousEnd);
      return true;
    }
    const end = lineEnd(this.graphemes, this.cursorIndex);
    if (end >= this.graphemes.length) return false;
    const nextStart = end + 1;
    const nextEnd = lineEnd(this.graphemes, nextStart);
    this.cursorIndex = Math.min(nextStart + column, nextEnd);
    return true;
  }

  private moveWord(direction: -1 | 1): boolean {
    const next = direction < 0
      ? previousWordBoundary(this.graphemes, this.cursorIndex)
      : nextWordBoundary(this.graphemes, this.cursorIndex);
    if (next === this.cursorIndex) return false;
    this.cursorIndex = next;
    return true;
  }

  private deleteWordBackward(): boolean {
    const start = previousWordBoundary(this.graphemes, this.cursorIndex);
    if (start === this.cursorIndex) return false;
    this.graphemes.splice(start, this.cursorIndex - start);
    this.cursorIndex = start;
    this.changed();
    return true;
  }

  private navigateHistory(direction: -1 | 1): boolean {
    const history = this.options.history;
    if (history === undefined) return false;
    const value = direction < 0
      ? history.previous(this.value)
      : history.next();
    if (value === undefined) return false;
    this.graphemes = segment(value);
    this.cursorIndex = this.graphemes.length;
    this.changed();
    return true;
  }

  private changed(): void {
    this.options.onChange?.(this.value);
  }
}

function renderEditor(
  graphemes: readonly string[],
  cursorIndex: number,
  width: number,
  firstPrompt: string,
  continuationPrompt: string,
): { readonly lines: readonly string[]; readonly cursor: CursorPosition } {
  const lines: string[] = [];
  let prompt = fitPrefix(firstPrompt, width);
  let line = prompt;
  let lineWidth = stringWidth(prompt);
  let promptWidth = lineWidth;
  let cursor: CursorPosition | undefined;

  const nextLine = (): void => {
    lines.push(line);
    prompt = fitPrefix(continuationPrompt, width);
    line = prompt;
    lineWidth = stringWidth(prompt);
    promptWidth = lineWidth;
  };

  for (let index = 0; index <= graphemes.length; index++) {
    if (index === cursorIndex) {
      if (lineWidth >= width) nextLine();
      cursor = { x: lineWidth, y: lines.length };
    }
    if (index === graphemes.length) break;
    const grapheme = graphemes[index]!;
    if (grapheme === "\n") {
      nextLine();
      continue;
    }
    const displayed = displayGrapheme(grapheme);
    const graphemeWidth = stringWidth(displayed);
    if (lineWidth + graphemeWidth > width && lineWidth > promptWidth) nextLine();
    if (lineWidth + graphemeWidth > width) {
      const available = width - lineWidth;
      line += available > 0 ? sliceAnsi(displayed, 0, available) : "";
      lineWidth = width;
    } else {
      line += displayed;
      lineWidth += graphemeWidth;
    }
  }
  lines.push(line);
  return { lines, cursor: cursor ?? { x: lineWidth, y: lines.length - 1 } };
}

function fitPrefix(value: string, width: number): string {
  if (width <= 1) return "";
  return sliceAnsi(value.replace(/[\r\n]/gu, ""), 0, width - 1);
}

function displayGrapheme(value: string): string {
  if (value === "\t") return "  ";
  if (/^[\u0000-\u001f\u007f-\u009f]$/u.test(value)) return "�";
  return value;
}

function normalizeValue(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function segment(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(value)].map((part) => part.segment);
}

function lineStart(graphemes: readonly string[], cursor: number): number {
  for (let index = cursor - 1; index >= 0; index--) {
    if (graphemes[index] === "\n") return index + 1;
  }
  return 0;
}

function lineEnd(graphemes: readonly string[], cursor: number): number {
  for (let index = cursor; index < graphemes.length; index++) {
    if (graphemes[index] === "\n") return index;
  }
  return graphemes.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function previousWordBoundary(graphemes: readonly string[], cursor: number): number {
  let index = cursor;
  while (index > 0 && wordClass(graphemes[index - 1]!) === "space") index -= 1;
  if (index === 0) return index;
  const kind = wordClass(graphemes[index - 1]!);
  while (index > 0 && wordClass(graphemes[index - 1]!) === kind) index -= 1;
  return index;
}

function nextWordBoundary(graphemes: readonly string[], cursor: number): number {
  let index = cursor;
  while (index < graphemes.length && wordClass(graphemes[index]!) === "space") {
    index += 1;
  }
  if (index >= graphemes.length) return index;
  const kind = wordClass(graphemes[index]!);
  while (index < graphemes.length && wordClass(graphemes[index]!) === kind) {
    index += 1;
  }
  return index;
}

function wordClass(value: string): "space" | "word" | "punctuation" {
  if (/^\s+$/u.test(value)) return "space";
  return /^[\p{Letter}\p{Number}\p{Mark}_]+$/u.test(value)
    ? "word"
    : "punctuation";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
