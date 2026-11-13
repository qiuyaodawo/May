import type { KeyBindingDefinition, KeyStroke } from "./keybindings/index.js";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type { FocusTarget, InteractiveComponent, PointerEvent, RenderResult, RenderSize } from "./component.js";
import type { Clipboard } from "./clipboard.js";
import { normalizeValue, type EditorHistory } from "./editor-history.js";
import { createEditorKeymap, EDITOR_ACTIONS, type EditorAction } from "./editor-keymap.js";
import {
  displayGrapheme,
  fitPrefix,
  indexAt,
  indexAtColumn,
  layoutEditor,
  type EditorLayout,
} from "./editor-layout.js";
import { styleText, type TextStyle } from "./theme.js";

/** @experimental */
export interface EditorOptions {
  readonly value?: string;
  readonly prompt?: string;
  readonly continuationPrompt?: string;
  readonly placeholder?: string;
  readonly promptStyle?: TextStyle;
  readonly placeholderStyle?: TextStyle;
  readonly history?: EditorHistory;
  readonly onChange?: (value: string) => void;
  readonly clipboard?: Clipboard;
  readonly onInvalidate?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly keybindings?: readonly KeyBindingDefinition[];
  readonly selectionStyle?: TextStyle;
  /** 未提供时，Enter 插入换行。Shift+Enter 始终插入换行。 */
  readonly onSubmit?: (value: string) => void;
}

/** @experimental */
export class Editor implements InteractiveComponent, FocusTarget {
  private graphemes: string[];
  private cursorIndex: number;
  private selectionAnchor: number | undefined;
  private focused = false;
  private readonly prompt: string;
  private readonly continuationPrompt: string;
  private readonly keymap;
  private revision = 0;
  private layout: EditorLayout | undefined;
  private renderSize: RenderSize | undefined;
  private viewportStart = 0;
  private preferredColumn: number | undefined;
  private dragging = false;
  private dragPointer: PointerEvent | undefined;
  private dragTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private pendingClipboard: Promise<void> = Promise.resolve();

  constructor(private readonly options: EditorOptions = {}) {
    this.graphemes = segment(normalizeValue(options.value ?? ""));
    this.cursorIndex = this.graphemes.length;
    this.keymap = createEditorKeymap(options.keybindings);
    this.prompt = styleText(options.prompt ?? "> ", options.promptStyle);
    this.continuationPrompt = styleText(options.continuationPrompt ?? "  ", options.promptStyle);
  }

  get value(): string {
    return this.graphemes.join("");
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get hasSelection(): boolean {
    return this.selectionAnchor !== undefined && this.selectionAnchor !== this.cursorIndex;
  }

  get selectedText(): string {
    const [start, end] = this.selectionRange();
    return this.graphemes.slice(start, end).join("");
  }

  clearSelection(): void {
    if (this.selectionAnchor === undefined) return;
    this.selectionAnchor = undefined;
    this.revision += 1;
  }

  selectAll(): void {
    this.selectionAnchor = 0;
    this.moveTo(this.graphemes.length, true);
    this.revision += 1;
  }

  resetKeybindings(): void {
    this.keymap.reset();
  }

  waitForPendingClipboard(): Promise<void> {
    return this.pendingClipboard;
  }

  setValue(value: string, cursor = segment(normalizeValue(value)).length): void {
    this.graphemes = segment(normalizeValue(value));
    this.cursorIndex = clamp(cursor, 0, this.graphemes.length);
    this.clearSelection();
    this.preferredColumn = undefined;
    this.stopDragging();
    this.keymap.reset();
    this.options.history?.reset();
    this.changed();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.stopDragging();
    this.keymap.reset();
    this.revision += 1;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused || this.disposed) return false;
    this.stopDragging();
    if (stroke.key === "paste") {
      this.keymap.reset();
      if (stroke.text === undefined) return false;
      this.insert(stroke.text);
      return true;
    }
    const match = this.keymap.resolve(stroke, this.hasSelection ? ["editor", "editor.selection"] : ["editor"]);
    if (match.type === "pending") return true;
    if (match.type === "action") {
      this.performAction(match.action as EditorAction);
      return true;
    }
    if (stroke.text === undefined || stroke.ctrl || stroke.alt || stroke.meta) return false;
    this.insert(stroke.text);
    return true;
  }

  handleKeyResult(stroke: KeyStroke): { readonly consumed: boolean; readonly redraw: boolean } {
    const revision = this.revision;
    const consumed = this.handleKey(stroke);
    return { consumed, redraw: this.revision !== revision };
  }

  handlePointer(event: PointerEvent): boolean {
    if (this.disposed || this.layout === undefined || this.renderSize === undefined) return false;
    if (event.type === "down") {
      if (event.button !== 0) return false;
      this.setFocused(true);
      this.keymap.reset();
      this.moveTo(this.pointerIndex(event.x, event.y), event.shift);
      if (this.selectionAnchor === undefined) this.selectionAnchor = this.cursorIndex;
      this.dragging = true;
      return true;
    }
    if (!this.dragging) return false;
    this.moveTo(this.pointerIndex(event.x, event.y), true);
    if (event.type === "up") this.stopDragging();
    else this.updateDragScroll(event);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.stopDragging();
    this.keymap.reset();
    this.revision += 1;
  }

  render(size: RenderSize): RenderResult {
    const rendered = layoutEditor(
      this.graphemes,
      size.width,
      this.prompt,
      this.continuationPrompt,
      this.selectionRange(),
      this.options.selectionStyle ?? { inverse: true },
    );
    this.layout = rendered;
    this.renderSize = size;
    let lines = rendered.lines;
    let cursor = rendered.positions[this.cursorIndex]!;
    if (this.graphemes.length === 0 && this.options.placeholder !== undefined) {
      const prefix = fitPrefix(this.prompt, size.width);
      lines = [
        sliceAnsi(
          `${prefix}${styleText(this.options.placeholder.replace(/[\r\n]+/gu, " "), this.options.placeholderStyle)}`,
          0,
          size.width,
        ),
      ];
      cursor = { x: stringWidth(prefix), y: 0 };
    }

    this.viewportStart = clamp(this.viewportStart, Math.max(0, cursor.y - size.height + 1), cursor.y);
    this.viewportStart = Math.min(this.viewportStart, Math.max(0, lines.length - size.height));
    const visibleLines = lines.slice(this.viewportStart, this.viewportStart + size.height);
    return {
      lines: visibleLines,
      cursor: {
        x: cursor.x,
        y: cursor.y - this.viewportStart,
        visible: this.focused,
      },
    };
  }

  performAction(action: EditorAction): void {
    switch (action) {
      case EDITOR_ACTIONS.left:
        this.moveCursor(-1);
        break;
      case EDITOR_ACTIONS.right:
        this.moveCursor(1);
        break;
      case EDITOR_ACTIONS.selectLeft:
        this.moveCursor(-1, true);
        break;
      case EDITOR_ACTIONS.selectRight:
        this.moveCursor(1, true);
        break;
      case EDITOR_ACTIONS.up:
        this.moveVertical(-1);
        break;
      case EDITOR_ACTIONS.down:
        this.moveVertical(1);
        break;
      case EDITOR_ACTIONS.selectUp:
        this.moveVertical(-1, true);
        break;
      case EDITOR_ACTIONS.selectDown:
        this.moveVertical(1, true);
        break;
      case EDITOR_ACTIONS.lineStart:
        this.moveTo(lineStart(this.graphemes, this.cursorIndex));
        break;
      case EDITOR_ACTIONS.lineEnd:
        this.moveTo(lineEnd(this.graphemes, this.cursorIndex));
        break;
      case EDITOR_ACTIONS.selectLineStart:
        this.moveTo(lineStart(this.graphemes, this.cursorIndex), true);
        break;
      case EDITOR_ACTIONS.selectLineEnd:
        this.moveTo(lineEnd(this.graphemes, this.cursorIndex), true);
        break;
      case EDITOR_ACTIONS.start:
        this.moveTo(0);
        break;
      case EDITOR_ACTIONS.end:
        this.moveTo(this.graphemes.length);
        break;
      case EDITOR_ACTIONS.selectStart:
        this.moveTo(0, true);
        break;
      case EDITOR_ACTIONS.selectEnd:
        this.moveTo(this.graphemes.length, true);
        break;
      case EDITOR_ACTIONS.wordLeft:
        this.moveWord(-1);
        break;
      case EDITOR_ACTIONS.wordRight:
        this.moveWord(1);
        break;
      case EDITOR_ACTIONS.selectWordLeft:
        this.moveWord(-1, true);
        break;
      case EDITOR_ACTIONS.selectWordRight:
        this.moveWord(1, true);
        break;
      case EDITOR_ACTIONS.selectAll:
        this.selectAll();
        break;
      case EDITOR_ACTIONS.copy:
        this.copy(false);
        break;
      case EDITOR_ACTIONS.cut:
        this.copy(true);
        break;
      case EDITOR_ACTIONS.paste:
        this.paste();
        break;
      case EDITOR_ACTIONS.backspace:
        this.backspace();
        break;
      case EDITOR_ACTIONS.delete:
        this.deleteForward();
        break;
      case EDITOR_ACTIONS.deleteWord:
        this.deleteWordBackward();
        break;
      case EDITOR_ACTIONS.newline:
        this.insert("\n");
        break;
      case EDITOR_ACTIONS.tab:
        this.insert("\t");
        break;
      case EDITOR_ACTIONS.submit:
        if (this.options.onSubmit === undefined) this.insert("\n");
        else {
          const value = this.value;
          this.options.history?.record(value);
          this.options.onSubmit(value);
        }
        break;
      default:
        throw new Error(`Unknown editor action: ${action}`);
    }
  }

  private insert(value: string): boolean {
    const inserted = segment(normalizeValue(value));
    if (inserted.length === 0) return false;
    const [start, end] = this.selectionRange();
    this.graphemes.splice(start, end - start, ...inserted);
    this.cursorIndex = start + inserted.length;
    this.selectionAnchor = undefined;
    this.preferredColumn = undefined;
    this.changed();
    return true;
  }

  private backspace(): boolean {
    if (this.deleteSelection()) return true;
    if (this.cursorIndex === 0) return false;
    this.selectionAnchor = undefined;
    this.graphemes.splice(this.cursorIndex - 1, 1);
    this.cursorIndex -= 1;
    this.changed();
    return true;
  }

  private deleteForward(): boolean {
    if (this.deleteSelection()) return true;
    if (this.cursorIndex >= this.graphemes.length) return false;
    this.selectionAnchor = undefined;
    this.graphemes.splice(this.cursorIndex, 1);
    this.changed();
    return true;
  }

  private moveCursor(offset: number, extend = false): void {
    const [start, end] = this.selectionRange();
    this.moveTo(!extend && this.hasSelection ? (offset < 0 ? start : end) : this.cursorIndex + offset, extend);
  }

  private moveTo(next: number, extend = false, preserveColumn = false): void {
    const previous = this.cursorIndex;
    const anchor = this.selectionAnchor;
    if (extend) this.selectionAnchor ??= previous;
    else this.selectionAnchor = undefined;
    this.cursorIndex = clamp(next, 0, this.graphemes.length);
    if (!preserveColumn) this.preferredColumn = undefined;
    if (this.cursorIndex !== previous || this.selectionAnchor !== anchor) this.revision += 1;
  }

  private moveVertical(direction: -1 | 1, extend = false): void {
    const hadSelection = this.hasSelection;
    if (this.layout !== undefined) {
      const position = this.layout.positions[this.cursorIndex]!;
      const nextRow = position.y + direction;
      if (nextRow >= 0 && nextRow < this.layout.rows.length) {
        this.preferredColumn ??= position.x;
        this.moveTo(indexAt(this.layout.rows[nextRow]!, this.preferredColumn), extend, true);
        return;
      }
      this.moveTo(this.cursorIndex, extend, true);
      if (!extend && !hadSelection) this.navigateHistory(direction);
      return;
    }
    const start = lineStart(this.graphemes, this.cursorIndex);
    const column = this.graphemes
      .slice(start, this.cursorIndex)
      .reduce((width, value) => width + stringWidth(displayGrapheme(value)), 0);
    if (direction < 0) {
      if (start > 0) {
        this.moveTo(indexAtColumn(this.graphemes, lineStart(this.graphemes, start - 1), start - 1, column), extend);
        return;
      }
    } else {
      const end = lineEnd(this.graphemes, this.cursorIndex);
      if (end < this.graphemes.length) {
        this.moveTo(indexAtColumn(this.graphemes, end + 1, lineEnd(this.graphemes, end + 1), column), extend);
        return;
      }
    }
    this.moveTo(this.cursorIndex, extend);
    if (!extend && !hadSelection) this.navigateHistory(direction);
  }

  private moveWord(direction: -1 | 1, extend = false): void {
    const next =
      direction < 0
        ? previousWordBoundary(this.graphemes, this.cursorIndex)
        : nextWordBoundary(this.graphemes, this.cursorIndex);
    this.moveTo(next, extend);
  }

  private deleteWordBackward(): boolean {
    if (this.deleteSelection()) return true;
    const start = previousWordBoundary(this.graphemes, this.cursorIndex);
    if (start === this.cursorIndex) return false;
    this.selectionAnchor = undefined;
    this.graphemes.splice(start, this.cursorIndex - start);
    this.cursorIndex = start;
    this.changed();
    return true;
  }

  private navigateHistory(direction: -1 | 1): boolean {
    const history = this.options.history;
    if (history === undefined) return false;
    const value = direction < 0 ? history.previous(this.value) : history.next();
    if (value === undefined) return false;
    this.graphemes = segment(value);
    this.cursorIndex = this.graphemes.length;
    this.selectionAnchor = undefined;
    this.preferredColumn = undefined;
    this.changed();
    return true;
  }

  private changed(): void {
    this.revision += 1;
    this.preferredColumn = undefined;
    this.layout = undefined;
    if (this.renderSize !== undefined) this.render(this.renderSize);
    this.options.onChange?.(this.value);
  }

  private selectionRange(): readonly [number, number] {
    const anchor = this.selectionAnchor ?? this.cursorIndex;
    return [Math.min(anchor, this.cursorIndex), Math.max(anchor, this.cursorIndex)];
  }

  private deleteSelection(): boolean {
    if (!this.hasSelection) return false;
    const [start, end] = this.selectionRange();
    this.graphemes.splice(start, end - start);
    this.cursorIndex = start;
    this.selectionAnchor = undefined;
    this.preferredColumn = undefined;
    this.changed();
    return true;
  }

  private copy(cut: boolean): void {
    if (!this.hasSelection) return;
    const clipboard = this.requireClipboard();
    const text = this.selectedText;
    const revision = this.revision;
    this.runClipboard(async () => {
      await clipboard.writeText(text);
      if (cut && this.revision === revision) {
        this.deleteSelection();
        this.options.onInvalidate?.();
      }
    });
  }

  private paste(): void {
    const clipboard = this.requireClipboard();
    const revision = this.revision;
    this.runClipboard(async () => {
      const text = await clipboard.readText();
      if (this.revision !== revision) return;
      this.insert(text);
      this.options.onInvalidate?.();
    });
  }

  private requireClipboard(): Clipboard {
    if (this.options.clipboard === undefined) throw new Error("Editor clipboard is not configured");
    return this.options.clipboard;
  }

  private runClipboard(operation: () => Promise<void>): void {
    this.pendingClipboard = this.pendingClipboard.then(operation, operation);
    void this.pendingClipboard.catch((error: unknown) => {
      if (this.options.onError !== undefined) this.options.onError(error);
      else
        queueMicrotask(() => {
          throw error;
        });
    });
  }

  private pointerIndex(x: number, y: number): number {
    const layout = this.layout!;
    const size = this.renderSize!;
    if (y < 0) this.viewportStart = Math.max(0, this.viewportStart - 1);
    else if (y >= size.height)
      this.viewportStart = Math.min(Math.max(0, layout.rows.length - size.height), this.viewportStart + 1);
    const row = clamp(this.viewportStart + clamp(y, 0, size.height - 1), 0, layout.rows.length - 1);
    return indexAt(layout.rows[row]!, x);
  }

  private updateDragScroll(event: PointerEvent): void {
    this.dragPointer = event;
    const height = this.renderSize!.height;
    if (event.y >= 0 && event.y < height) {
      if (this.dragTimer !== undefined) clearInterval(this.dragTimer);
      this.dragTimer = undefined;
      return;
    }
    this.dragTimer ??= setInterval(() => {
      const pointer = this.dragPointer;
      if (!this.dragging || pointer === undefined || this.renderSize === undefined) return;
      const revision = this.revision;
      this.moveTo(this.pointerIndex(pointer.x, pointer.y), true);
      if (this.revision !== revision) {
        this.render(this.renderSize);
        this.options.onInvalidate?.();
      }
    }, 60);
    this.dragTimer.unref();
  }

  private stopDragging(): void {
    this.dragging = false;
    this.dragPointer = undefined;
    if (this.dragTimer !== undefined) clearInterval(this.dragTimer);
    this.dragTimer = undefined;
  }
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
  return /^[\p{Letter}\p{Number}\p{Mark}_]+$/u.test(value) ? "word" : "punctuation";
}
