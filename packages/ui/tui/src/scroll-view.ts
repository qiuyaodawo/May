import { Keymap, mergeKeyBindings, type KeyBindingDefinition, type KeyStroke } from "@may/keybindings";
import type {
  Component,
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
  PointerEvent,
  KeyHandlingResult,
} from "./component.js";
import { placeImages } from "./component.js";

export interface ScrollViewOptions {
  readonly followEnd?: boolean;
  readonly maxContentLines?: number;
  readonly onInvalidate?: () => void;
  readonly keybindings?: readonly KeyBindingDefinition[];
}

export const DEFAULT_SCROLL_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  { context: "scroll", keys: "wheelup", action: "scroll.wheelUp" },
  { context: "scroll", keys: "wheeldown", action: "scroll.wheelDown" },
  { context: "scroll", keys: "up", action: "scroll.up" },
  { context: "scroll", keys: "down", action: "scroll.down" },
  { context: "scroll", keys: "pageup", action: "scroll.pageUp" },
  { context: "scroll", keys: "pagedown", action: "scroll.pageDown" },
  { context: "scroll", keys: "home", action: "scroll.start" },
  { context: "scroll", keys: "end", action: "scroll.end" },
];

export interface ScrollRegion {
  /** Inclusive zero-based content row. */
  readonly start: number;
  /** Inclusive zero-based content row. */
  readonly end: number;
}

/** A viewport over a child component's rendered lines. */
export class ScrollView implements InteractiveComponent, FocusTarget {
  private offset = 0;
  private followEnd: boolean;
  private readonly maxContentLines: number;
  private focused = false;
  private lastMaximumOffset = 0;
  private lastPageSize = 1;
  private pendingAnchor: PendingScrollAnchor | undefined;
  private topAnchor: (() => ScrollRegion | undefined) | undefined;
  private alignedToStart = false;
  private readonly keymap: Keymap;
  private readonly onInvalidate: (() => void) | undefined;
  private pointer: PointerEvent | undefined;
  private dragTimer: ReturnType<typeof setInterval> | undefined;
  private viewportAnchor: { sourceId: string; offset: number; screenRow: number } | undefined;

  constructor(
    private readonly child: Component,
    options: ScrollViewOptions = {},
  ) {
    this.followEnd = options.followEnd ?? false;
    this.maxContentLines = options.maxContentLines ?? 10_000;
    this.onInvalidate = options.onInvalidate;
    this.keymap = new Keymap(mergeKeyBindings(DEFAULT_SCROLL_KEYBINDINGS, options.keybindings), {
      actions: DEFAULT_SCROLL_KEYBINDINGS.map(binding => binding.action),
    });
    if (!Number.isInteger(this.maxContentLines) || this.maxContentLines < 1) {
      throw new RangeError("maxContentLines must be a positive integer");
    }
  }

  get scrollOffset(): number {
    return this.offset;
  }

  /** 在渲染后将目标第一行置于顶部，并在内容变化时保持该位置。 */
  scrollToAnchor(resolveAfterRender: () => ScrollRegion | undefined): void {
    this.viewportAnchor = undefined;
    this.followEnd = false;
    this.pendingAnchor = undefined;
    this.topAnchor = resolveAfterRender;
    this.alignedToStart = true;
  }

  setFocused(focused: boolean): void {
    if (this.focused !== focused) this.keymap.reset();
    this.focused = focused;
    if (isFocusTarget(this.child)) this.child.setFocused(focused);
  }

  /** Stop following appended content without changing the current viewport. */
  detachFromEnd(): void {
    this.followEnd = false;
  }

  /** Keep a logical content row at its current screen row across the next render. */
  preserveAnchor(
    region: ScrollRegion,
    resolveAfterRender: () => ScrollRegion | undefined,
  ): void {
    if (this.topAnchor !== undefined) return;
    this.viewportAnchor = undefined;
    this.followEnd = false;
    if (region.start < this.offset || region.start >= this.offset + this.lastPageSize) {
      this.pendingAnchor = undefined;
      return;
    }
    this.pendingAnchor = {
      screenRow: region.start - this.offset,
      resolveAfterRender,
    };
  }

  ensureVisible(region: ScrollRegion, margin = 1): boolean {
    this.viewportAnchor = undefined;
    this.topAnchor = undefined;
    this.alignedToStart = false;
    const safeMargin = Math.max(0, Math.min(Math.trunc(margin), this.lastPageSize - 1));
    let next = this.offset;
    if (region.start < this.offset + safeMargin) {
      next = region.start - safeMargin;
    } else if (region.end >= this.offset + this.lastPageSize - safeMargin) {
      next = region.end - this.lastPageSize + safeMargin + 1;
    }
    next = clamp(next, 0, this.lastMaximumOffset);
    if (next === this.offset && !this.followEnd) return false;
    this.offset = next;
    this.followEnd = false;
    return true;
  }

  scrollBy(lines: number): boolean {
    this.viewportAnchor = undefined;
    this.topAnchor = undefined;
    const next = clamp(this.offset + Math.trunc(lines), 0, Math.max(this.offset, this.lastMaximumOffset));
    if (next === this.offset) return false;
    this.offset = next;
    this.followEnd = this.offset === this.lastMaximumOffset;
    return true;
  }

  scrollToStart(): boolean {
    this.viewportAnchor = undefined;
    this.topAnchor = undefined;
    this.alignedToStart = false;
    if (this.offset === 0 && !this.followEnd) return false;
    this.offset = 0;
    this.followEnd = false;
    return true;
  }

  scrollToEnd(): boolean {
    this.viewportAnchor = undefined;
    this.topAnchor = undefined;
    this.alignedToStart = false;
    if (this.offset === this.lastMaximumOffset && this.followEnd) return false;
    this.offset = this.lastMaximumOffset;
    this.followEnd = true;
    return true;
  }

  handleKey(stroke: KeyStroke): boolean {
    return this.handleKeyResult(stroke).consumed;
  }

  handleKeyResult(stroke: KeyStroke): KeyHandlingResult {
    if (!this.focused) return { consumed: false, redraw: false };
    if (isInteractive(this.child) && this.child.handleKey(stroke)) {
      this.followEnd = false;
      return { consumed: true, redraw: true };
    }
    const result = this.keymap.resolve(stroke, ["scroll"]);
    if (result.type !== "action") return { consumed: result.type === "pending", redraw: false };
    let redraw: boolean;
    switch (result.action) {
      case "scroll.wheelUp": redraw = this.scrollBy(-3); break;
      case "scroll.wheelDown": redraw = this.scrollBy(3); break;
      case "scroll.up": redraw = this.scrollBy(-1); break;
      case "scroll.down": redraw = this.scrollBy(1); break;
      case "scroll.pageUp": redraw = this.scrollBy(-this.lastPageSize); break;
      case "scroll.pageDown": redraw = this.scrollBy(this.lastPageSize); break;
      case "scroll.start": redraw = this.scrollToStart(); break;
      case "scroll.end": redraw = this.scrollToEnd(); break;
      default: throw new Error(`Unknown scroll action: ${result.action}`);
    }
    return { consumed: true, redraw };
  }

  handlePointer(event: PointerEvent): boolean {
    if (this.child.handlePointer === undefined) return false;
    if (event.type !== "down" && this.pointer === undefined) return false;
    const consumed = this.child.handlePointer({ ...event,
      y: this.offset + clamp(event.y, 0, this.lastPageSize - 1) });
    if (event.type === "down" && consumed) {
      this.followEnd = false;
      this.topAnchor = undefined;
      this.alignedToStart = false;
      this.pointer = event;
    } else if (this.pointer !== undefined) this.pointer = event;
    if (event.type === "up") this.stopDragging();
    else if (this.pointer !== undefined) this.updateAutoScroll();
    return consumed;
  }

  clearPointerSelection(): void {
    this.stopDragging();
    if ("clearSelection" in this.child && typeof this.child.clearSelection === "function") this.child.clearSelection();
  }

  dispose(): void {
    this.stopDragging();
    this.child.dispose?.();
  }

  private stopDragging(): void {
    this.pointer = undefined;
    if (this.dragTimer !== undefined) clearInterval(this.dragTimer);
    this.dragTimer = undefined;
  }

  private updateAutoScroll(): void {
    const pointer = this.pointer;
    const atEdge = pointer !== undefined && (pointer.y <= 0 || pointer.y >= this.lastPageSize - 1);
    if (!atEdge && this.dragTimer !== undefined) {
      clearInterval(this.dragTimer);
      this.dragTimer = undefined;
    } else if (atEdge && this.dragTimer === undefined) {
      this.dragTimer = setInterval(() => {
        const event = this.pointer;
        if (event === undefined) return;
        const direction = event.y <= 0 ? -1 : 1;
        if (!this.scrollBy(direction)) return;
        this.followEnd = false;
        this.child.handlePointer?.({ ...event, type: "move", y: this.offset + clamp(event.y, 0, this.lastPageSize - 1) });
        this.onInvalidate?.();
      }, 60);
      this.dragTimer.unref?.();
    }
  }

  render(size: RenderSize): RenderResult {
    const renderSize = {
      width: size.width,
      height: this.maxContentLines,
    };
    const content = isTailRenderable(this.child)
      ? this.child.renderTail(renderSize)
      : this.child.render(renderSize);
    this.lastPageSize = size.height;
    this.lastMaximumOffset = Math.max(0, content.lines.length - size.height);
    const pendingAnchor = this.pendingAnchor;
    this.pendingAnchor = undefined;
    const anchoredRegion = pendingAnchor?.resolveAfterRender();
    const topRegion = this.topAnchor?.();
    const maximumOffset = this.alignedToStart
      ? Math.max(0, content.lines.length - 1)
      : this.lastMaximumOffset;
    const anchor = this.viewportAnchor;
    const anchorIndex = anchor === undefined ? -1 : (content.textRows ?? []).findIndex(row => row?.sourceId === anchor.sourceId &&
      row.start <= anchor.offset && row.end > anchor.offset);
    this.offset = topRegion !== undefined
      ? clamp(topRegion.start, 0, maximumOffset)
      : anchoredRegion !== undefined && pendingAnchor !== undefined
      ? clamp(anchoredRegion.start - pendingAnchor.screenRow, 0, this.lastMaximumOffset)
      : this.followEnd
      ? this.lastMaximumOffset
      : anchorIndex >= 0 && anchor !== undefined
      ? clamp(anchorIndex - anchor.screenRow, 0, maximumOffset)
      : clamp(this.offset, 0, maximumOffset);

    this.viewportAnchor = undefined;
    for (let index = this.offset; index < Math.min(content.lines.length, this.offset + size.height); index++) {
      const row = content.textRows?.[index];
      if (row !== undefined && row.end > row.start) {
        this.viewportAnchor = { sourceId: row.sourceId, offset: row.start, screenRow: index - this.offset };
        break;
      }
    }

    const cursor = content.cursor;
    const cursorVisible = cursor !== undefined &&
      cursor.y >= this.offset && cursor.y < this.offset + size.height;
    return {
      lines: content.lines.slice(this.offset, this.offset + size.height),
      ...(content.textRows ? { textRows: content.textRows.slice(this.offset, this.offset + size.height) } : {}),
      ...(content.images?.length ? { images: placeImages(content.images, -this.offset, size.height) } : {}),
      ...(cursorVisible
        ? {
            cursor: {
              ...cursor,
              y: cursor.y - this.offset,
              visible: this.focused && cursor.visible !== false,
            },
          }
        : {}),
    };
  }
}

interface TailRenderableComponent extends Component {
  /** Render the newest bounded content instead of truncating appended rows. */
  renderTail(size: RenderSize): RenderResult;
}

function isTailRenderable(component: Component): component is TailRenderableComponent {
  return "renderTail" in component && typeof component.renderTail === "function";
}

interface PendingScrollAnchor {
  readonly screenRow: number;
  readonly resolveAfterRender: () => ScrollRegion | undefined;
}

function isInteractive(component: Component): component is InteractiveComponent {
  return "handleKey" in component && typeof component.handleKey === "function";
}

function isFocusTarget(component: Component): component is Component & FocusTarget {
  return "setFocused" in component && typeof component.setFocused === "function";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
