import type { KeyStroke } from "@may/keybindings";
import type {
  Component,
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "./component.js";

export interface ScrollViewOptions {
  readonly followEnd?: boolean;
  readonly maxContentLines?: number;
}

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

  constructor(
    private readonly child: Component,
    options: ScrollViewOptions = {},
  ) {
    this.followEnd = options.followEnd ?? false;
    this.maxContentLines = options.maxContentLines ?? 10_000;
    if (!Number.isInteger(this.maxContentLines) || this.maxContentLines < 1) {
      throw new RangeError("maxContentLines must be a positive integer");
    }
  }

  get scrollOffset(): number {
    return this.offset;
  }

  setFocused(focused: boolean): void {
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
    const next = clamp(this.offset + Math.trunc(lines), 0, this.lastMaximumOffset);
    if (next === this.offset) return false;
    this.offset = next;
    this.followEnd = this.offset === this.lastMaximumOffset;
    return true;
  }

  scrollToStart(): boolean {
    if (this.offset === 0 && !this.followEnd) return false;
    this.offset = 0;
    this.followEnd = false;
    return true;
  }

  scrollToEnd(): boolean {
    if (this.offset === this.lastMaximumOffset && this.followEnd) return false;
    this.offset = this.lastMaximumOffset;
    this.followEnd = true;
    return true;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused) return false;
    if (isInteractive(this.child) && this.child.handleKey(stroke)) {
      this.followEnd = false;
      return true;
    }
    switch (stroke.key) {
      case "up":
        return this.scrollBy(-1);
      case "down":
        return this.scrollBy(1);
      case "pageup":
        return this.scrollBy(-this.lastPageSize);
      case "pagedown":
        return this.scrollBy(this.lastPageSize);
      case "home":
        return this.scrollToStart();
      case "end":
        return this.scrollToEnd();
      default:
        return false;
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
    this.offset = anchoredRegion !== undefined && pendingAnchor !== undefined
      ? clamp(anchoredRegion.start - pendingAnchor.screenRow, 0, this.lastMaximumOffset)
      : this.followEnd
      ? this.lastMaximumOffset
      : clamp(this.offset, 0, this.lastMaximumOffset);

    const cursor = content.cursor;
    const cursorVisible = cursor !== undefined &&
      cursor.y >= this.offset && cursor.y < this.offset + size.height;
    return {
      lines: content.lines.slice(this.offset, this.offset + size.height),
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
