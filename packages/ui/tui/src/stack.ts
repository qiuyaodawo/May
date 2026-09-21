import type {
  Component,
  CursorPosition,
  RenderResult,
  RenderSize,
  PointerEvent,
} from "./component.js";
import { placeImages, type ImagePlacement } from "./component.js";
import type { TextRow } from "./text-selection.js";

export interface StackOptions {
  readonly gap?: number;
}

export class Stack implements Component {
  private readonly gap: number;
  private bounds: Array<{ child: Component; y: number; height: number }> = [];
  private captured: { child: Component; y: number } | undefined;

  constructor(
    private readonly children: readonly Component[],
    options: StackOptions = {},
  ) {
    this.gap = options.gap ?? 0;
    if (!Number.isInteger(this.gap) || this.gap < 0) {
      throw new RangeError("Stack gap must be a non-negative integer");
    }
  }

  render(size: RenderSize): RenderResult {
    const lines: string[] = [];
    const images: ImagePlacement[] = [];
    const textRows: Array<TextRow | undefined> = [];
    this.bounds = [];
    let cursor: CursorPosition | undefined;

    for (const child of this.children) {
      if (lines.length >= size.height) break;
      if (lines.length > 0 && this.gap > 0) {
        const count = Math.min(this.gap, size.height - lines.length);
        lines.push(...Array.from({ length: count }, () => ""));
        textRows.push(...Array.from({ length: count }, () => undefined));
      }
      if (lines.length >= size.height) break;

      const offset = lines.length;
      const result = child.render({
        width: size.width,
        height: size.height - lines.length,
      });
      lines.push(...result.lines.slice(0, size.height - lines.length));
      textRows.push(...result.lines.map((_, index) => result.textRows?.[index]));
      this.bounds.push({ child, y: offset, height: result.lines.length });
      if (this.captured?.child === child) this.captured.y = offset;
      images.push(...placeImages(result.images, offset, size.height));
      if (cursor === undefined && result.cursor !== undefined) {
        cursor = { ...result.cursor, y: result.cursor.y + offset };
      }
    }

    return {
      lines,
      ...(textRows.some(row => row !== undefined) ? { textRows } : {}),
      ...(images.length ? { images } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  handlePointer(event: PointerEvent): boolean {
    const target = event.type === "down"
      ? this.bounds.find(bound => event.y >= bound.y && event.y < bound.y + bound.height)
      : this.bounds.find(bound => bound.child === this.captured?.child);
    if (event.type === "down") this.captured = undefined;
    if (target === undefined || !("handlePointer" in target.child) || typeof target.child.handlePointer !== "function") return false;
    const consumed = target.child.handlePointer({ ...event, y: event.y - target.y }) as boolean;
    if (event.type === "down" && consumed) this.captured = { child: target.child, y: target.y };
    if (event.type === "up") this.captured = undefined;
    return consumed;
  }

  dispose(): void {
    this.captured = undefined;
    this.bounds = [];
    for (const child of this.children) child.dispose?.();
  }
}
