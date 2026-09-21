import type {
  Component,
  CursorPosition,
  RenderResult,
  RenderSize,
  PointerEvent,
} from "./component.js";
import { placeImages, type ImagePlacement } from "./component.js";
import type { TextRow } from "./text-selection.js";

export interface ColumnItem {
  readonly component: Component;
  /** Exact preferred row count. Fixed regions are allocated before flex regions. */
  readonly height?: number;
  /** Relative share of rows left after fixed regions. Defaults to 1. */
  readonly flex?: number;
  readonly minHeight?: number;
}

export interface ColumnOptions {
  readonly gap?: number;
}

/** Fixed/flexible vertical region layout with stable footer placement. */
export class Column implements Component {
  private readonly gap: number;
  private regions: { component: Component; y: number; height: number }[] = [];
  private captured: Component | undefined;

  constructor(
    private items: readonly ColumnItem[],
    options: ColumnOptions = {},
  ) {
    this.gap = integer(options.gap ?? 0, "Column gap");
    for (const item of items) {
      if (item.height !== undefined && item.flex !== undefined) {
        throw new Error("A column item cannot define both height and flex");
      }
      if (item.height !== undefined) integer(item.height, "Column item height");
      if (item.minHeight !== undefined) integer(item.minHeight, "Column item minHeight");
      if (item.flex !== undefined && (!Number.isFinite(item.flex) || item.flex <= 0)) {
        throw new RangeError("Column item flex must be positive");
      }
    }
  }

  setItems(items: readonly ColumnItem[]): void {
    for (const item of items) {
      if (item.height !== undefined && item.flex !== undefined) throw new Error("A column item cannot define both height and flex");
      if (item.height !== undefined) integer(item.height, "Column item height");
      if (item.minHeight !== undefined) integer(item.minHeight, "Column item minHeight");
      if (item.flex !== undefined && (!Number.isFinite(item.flex) || item.flex <= 0)) throw new RangeError("Column item flex must be positive");
    }
    this.items = items;
    if (this.captured !== undefined && !items.some(item => item.component === this.captured)) this.captured = undefined;
  }

  render(size: RenderSize): RenderResult {
    this.regions = [];
    if (this.items.length === 0) return { lines: [] };
    const totalGap = this.gap * Math.max(0, this.items.length - 1);
    const available = Math.max(0, size.height - totalGap);
    const heights = allocateHeights(this.items, available);
    const lines: string[] = [];
    const images: ImagePlacement[] = [];
    const textRows: Array<TextRow | undefined> = [];
    let cursor: CursorPosition | undefined;

    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const height = heights[index]!;
      if (index > 0) {
        lines.push(...blankLines(Math.min(this.gap, size.height - lines.length)));
      }
      if (height <= 0 || lines.length >= size.height) continue;
      const offset = lines.length;
      this.regions.push({ component: item.component, y: offset, height });
      const result = item.component.render({ width: size.width, height });
      const visible = result.lines.slice(0, height);
      images.push(...placeImages(placeImages(result.images, 0, height), offset, size.height));
      lines.push(...visible, ...blankLines(height - visible.length));
      while (textRows.length < offset) textRows.push(undefined);
      textRows.push(...Array.from({ length: height }, (_, row) => result.textRows?.[row]));
      if (cursor === undefined && result.cursor !== undefined) {
        cursor = { ...result.cursor, y: result.cursor.y + offset };
      }
    }

    return {
      lines: lines.slice(0, size.height),
      ...(images.length ? { images } : {}),
      ...(textRows.some(row => row !== undefined) ? { textRows: textRows.slice(0, size.height) } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  handlePointer(event: PointerEvent): boolean {
    if (event.type === "down") this.captured = undefined;
    const region = this.regions.find(region => this.captured === undefined
      ? event.y >= region.y && event.y < region.y + region.height
      : region.component === this.captured);
    if (region === undefined) {
      if (event.type === "up") this.captured = undefined;
      return false;
    }
    const handled = region.component.handlePointer?.({ ...event, y: event.y - region.y }) ?? false;
    if (event.type === "down" && handled) this.captured = region.component;
    if (event.type === "up") this.captured = undefined;
    return handled;
  }

  dispose(): void {
    this.captured = undefined;
    for (const item of this.items) item.component.dispose?.();
  }
}

function allocateHeights(items: readonly ColumnItem[], available: number): number[] {
  const heights = items.map((item) => item.height ?? item.minHeight ?? 0);
  let remaining = available - heights.reduce((sum, value) => sum + value, 0);

  if (remaining < 0) {
    const order = items.map((_, index) => index).sort((a, b) =>
      Number(items[a]!.height !== undefined) - Number(items[b]!.height !== undefined) || a - b);
    for (const index of order) {
      if (remaining >= 0) break;
      const reduction = Math.min(heights[index]!, -remaining);
      heights[index] = heights[index]! - reduction;
      remaining += reduction;
    }
    return heights;
  }

  const flexItems = items
    .map((item, index) => ({ index, weight: item.height === undefined ? item.flex ?? 1 : 0 }))
    .filter((item) => item.weight > 0);
  let totalWeight = flexItems.reduce((sum, item) => sum + item.weight, 0);
  for (const item of flexItems) {
    const share = totalWeight === item.weight
      ? remaining
      : Math.floor(remaining * item.weight / totalWeight);
    heights[item.index] = heights[item.index]! + share;
    remaining -= share;
    totalWeight -= item.weight;
  }
  return heights;
}

function blankLines(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => "");
}

function integer(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}
