import type { KeyStroke } from "@may/keybindings";
import type { TextRow } from "./text-selection.js";

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
  readonly textRows?: readonly (TextRow | undefined)[];
  readonly images?: readonly ImagePlacement[];
  readonly lines: readonly string[];
  readonly cursor?: CursorPosition;
}

export type ImagePlacement = {
  readonly id: string;
  readonly png: string;
  readonly x: number;
  readonly y: number;
  readonly columns: number;
  readonly rows: number;
} & ({ readonly protocol: "kitty" | "iterm2" } | { readonly protocol: "sixel"; readonly sixel: string });

export function placeImages(images: readonly ImagePlacement[] | undefined, y: number, height: number): ImagePlacement[] {
  return (images ?? []).map(image => ({ ...image, y: image.y + y })).filter(image => image.y >= 0 && image.y + image.rows <= height);
}

export interface Component {
  render(size: RenderSize): RenderResult;
  handlePointer?(event: PointerEvent): boolean;
  dispose?(): void;
}

export interface PointerEvent {
  readonly type: "down" | "move" | "up";
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface KeyHandlingResult {
  readonly consumed: boolean;
  readonly redraw: boolean;
}

export interface InteractiveComponent extends Component {
  /** 返回按键是否已处理；没有改变内容的边界操作也应返回 true。 */
  handleKey(stroke: KeyStroke): boolean;
  handleKeyResult?(stroke: KeyStroke): KeyHandlingResult;
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
