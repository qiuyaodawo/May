import type {
  Component,
  CursorPosition,
  RenderResult,
  RenderSize,
} from "./component.js";
import { placeImages, type ImagePlacement } from "./component.js";

export interface StackOptions {
  readonly gap?: number;
}

export class Stack implements Component {
  private readonly gap: number;

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
    let cursor: CursorPosition | undefined;

    for (const child of this.children) {
      if (lines.length >= size.height) break;
      if (lines.length > 0 && this.gap > 0) {
        const count = Math.min(this.gap, size.height - lines.length);
        lines.push(...Array.from({ length: count }, () => ""));
      }
      if (lines.length >= size.height) break;

      const offset = lines.length;
      const result = child.render({
        width: size.width,
        height: size.height - lines.length,
      });
      lines.push(...result.lines.slice(0, size.height - lines.length));
      images.push(...placeImages(result.images, offset, size.height));
      if (cursor === undefined && result.cursor !== undefined) {
        cursor = { ...result.cursor, y: result.cursor.y + offset };
      }
    }

    return {
      lines,
      ...(images.length ? { images } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
}
