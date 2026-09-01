import type { KeyStroke } from "@may/keybindings";

export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

export interface CursorPosition {
  /** Zero-based display column. */
  readonly x: number;
  /** Zero-based row within the rendered frame. */
  readonly y: number;
  readonly visible?: boolean;
}

export interface RenderResult {
  readonly lines: readonly string[];
  readonly cursor?: CursorPosition;
}

export interface Component {
  render(size: RenderSize): RenderResult;
}

export interface InteractiveComponent extends Component {
  /** Return true when the key was consumed and the view should be redrawn. */
  handleKey(stroke: KeyStroke): boolean;
}

export interface FocusTarget {
  setFocused(focused: boolean): void;
  handleKey(stroke: KeyStroke): boolean;
}

export function renderComponent(
  component: Component,
  size: RenderSize,
): RenderResult {
  assertRenderSize(size);
  return component.render(size);
}

export function assertRenderSize(size: RenderSize): void {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new RangeError("Render width must be a positive integer");
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new RangeError("Render height must be a positive integer");
  }
}
