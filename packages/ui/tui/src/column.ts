import type {
  Component,
  CursorPosition,
  RenderResult,
  RenderSize,
} from "./component.js";

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

  constructor(
    private readonly items: readonly ColumnItem[],
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

  render(size: RenderSize): RenderResult {
    if (this.items.length === 0) return { lines: [] };
    const totalGap = this.gap * Math.max(0, this.items.length - 1);
    const available = Math.max(0, size.height - totalGap);
    const heights = allocateHeights(this.items, available);
    const lines: string[] = [];
    let cursor: CursorPosition | undefined;

    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const height = heights[index]!;
      if (index > 0) {
        lines.push(...blankLines(Math.min(this.gap, size.height - lines.length)));
      }
      if (height <= 0 || lines.length >= size.height) continue;
      const offset = lines.length;
      const result = item.component.render({ width: size.width, height });
      const visible = result.lines.slice(0, height);
      lines.push(...visible, ...blankLines(height - visible.length));
      if (cursor === undefined && result.cursor !== undefined) {
        cursor = { ...result.cursor, y: result.cursor.y + offset };
      }
    }

    return {
      lines: lines.slice(0, size.height),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
}

function allocateHeights(items: readonly ColumnItem[], available: number): number[] {
  const heights = items.map((item) => item.height ?? item.minHeight ?? 0);
  let remaining = available - heights.reduce((sum, value) => sum + value, 0);

  if (remaining < 0) {
    for (let index = heights.length - 1; index >= 0 && remaining < 0; index--) {
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
