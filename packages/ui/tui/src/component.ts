import type { KeyStroke } from "./keybindings/index.js";
import type { TextRow } from "./text-selection.js";

/** @experimental */
export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

/** @experimental */
export interface CursorPosition {
  /** Zero-based display column. */
  readonly x: number;
  /** Zero-based row within the rendered frame. */
  readonly y: number;
  readonly visible?: boolean;
}

/** @experimental */
export interface RenderResult {
  readonly textRows?: readonly (TextRow | undefined)[];
  readonly images?: readonly ImagePlacement[];
  readonly lines: readonly string[];
  readonly cursor?: CursorPosition;
}

/** @experimental */
export type ImagePlacement = {
  readonly id: string;
  readonly png: string;
  readonly x: number;
  readonly y: number;
  readonly columns: number;
  readonly rows: number;
} & ({ readonly protocol: "kitty" | "iterm2" } | { readonly protocol: "sixel"; readonly sixel: string });

/** @experimental */
export function placeImages(
  images: readonly ImagePlacement[] | undefined,
  y: number,
  height: number,
): ImagePlacement[] {
  return (images ?? [])
    .map((image) => ({ ...image, y: image.y + y }))
    .filter((image) => image.y >= 0 && image.y + image.rows <= height);
}

/** @experimental */
export interface Component {
  render(size: RenderSize): RenderResult;
  handlePointer?(event: PointerEvent): boolean;
  dispose?(): void;
}

/** @experimental */
export interface PointerEvent {
  readonly type: "down" | "move" | "up";
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** @experimental */
export interface KeyHandlingResult {
  readonly consumed: boolean;
  readonly redraw: boolean;
}

/** @experimental */
export interface InteractiveComponent extends Component {
  /** 返回按键是否已处理；没有改变内容的边界操作也应返回 true。 */
  handleKey(stroke: KeyStroke): boolean;
  handleKeyResult?(stroke: KeyStroke): KeyHandlingResult;
}

/** @experimental */
export interface FocusTarget {
  setFocused(focused: boolean): void;
  handleKey(stroke: KeyStroke): boolean;
}

/** @experimental */
export function renderComponent(component: Component, size: RenderSize): RenderResult {
  assertRenderSize(size);
  return component.render(size);
}

/** @experimental */
export function assertRenderSize(size: RenderSize): void {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new RangeError("Render width must be a positive integer");
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new RangeError("Render height must be a positive integer");
  }
}
