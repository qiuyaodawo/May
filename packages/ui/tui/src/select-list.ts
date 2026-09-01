import type { KeyStroke } from "@may/keybindings";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type {
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "./component.js";
import { styleText, type TextStyle } from "./theme.js";

export interface SelectItem<T = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SelectListOptions<T> {
  readonly selectedIndex?: number;
  readonly emptyLabel?: string;
  readonly onSelect?: (item: SelectItem<T>, index: number) => void;
  readonly onCancel?: () => void;
  readonly selectedStyle?: TextStyle;
  readonly descriptionStyle?: TextStyle;
  readonly disabledStyle?: TextStyle;
  readonly markerStyle?: TextStyle;
}

export class SelectList<T = string>
  implements InteractiveComponent, FocusTarget {
  private items: readonly SelectItem<T>[];
  private index: number;
  private offset = 0;
  private pageSize = 1;
  private focused = false;

  constructor(
    items: readonly SelectItem<T>[],
    private readonly options: SelectListOptions<T> = {},
  ) {
    this.items = [...items];
    this.index = firstEnabled(this.items, options.selectedIndex ?? 0);
  }

  get selectedIndex(): number {
    return this.index;
  }

  get selectedItem(): SelectItem<T> | undefined {
    return this.index < 0 ? undefined : this.items[this.index];
  }

  setItems(items: readonly SelectItem<T>[]): void {
    this.items = [...items];
    this.index = firstEnabled(this.items, Math.max(0, this.index));
    this.offset = 0;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused) return false;
    switch (stroke.key) {
      case "up":
        return this.move(-1);
      case "down":
        return this.move(1);
      case "pageup":
        return this.move(-this.pageSize);
      case "pagedown":
        return this.move(this.pageSize);
      case "home":
        return this.moveTo(firstEnabled(this.items, 0));
      case "end":
        return this.moveTo(lastEnabled(this.items));
      case "enter": {
        const item = this.selectedItem;
        if (item === undefined) return false;
        this.options.onSelect?.(item, this.index);
        return true;
      }
      case "escape":
        this.options.onCancel?.();
        return this.options.onCancel !== undefined;
      default:
        return false;
    }
  }

  render(size: RenderSize): RenderResult {
    if (this.items.length === 0) {
      return { lines: [sliceAnsi(this.options.emptyLabel ?? "No items", 0, size.width)] };
    }
    this.pageSize = size.height;
    if (this.index >= 0) {
      if (this.index < this.offset) this.offset = this.index;
      if (this.index >= this.offset + size.height) {
        this.offset = this.index - size.height + 1;
      }
    }
    const maximumOffset = Math.max(0, this.items.length - size.height);
    this.offset = clamp(this.offset, 0, maximumOffset);

    return {
      lines: this.items
        .slice(this.offset, this.offset + size.height)
        .map((item, relativeIndex) => {
          const index = this.offset + relativeIndex;
          const marker = index === this.index ? (this.focused ? "> " : "· ") : "  ";
          const disabled = item.disabled === true ? " (disabled)" : "";
          const plainDescription = item.description === undefined
            ? ""
            : ` — ${singleLine(item.description)}`;
          if (index === this.index) {
            const clipped = sliceAnsi(
              `${marker}${singleLine(item.label)}${disabled}${plainDescription}`,
              0,
              size.width,
            );
            const padded = `${clipped}${" ".repeat(Math.max(0, size.width - stringWidth(clipped)))}`;
            return styleText(padded, this.options.selectedStyle);
          }
          const description = styleText(plainDescription, this.options.descriptionStyle);
          const line = `${styleText(marker, this.options.markerStyle)}` +
            `${singleLine(item.label)}${disabled}${description}`;
          return sliceAnsi(styleText(
            line,
            item.disabled === true ? this.options.disabledStyle : undefined,
          ), 0, size.width);
        }),
    };
  }

  private move(offset: number): boolean {
    if (this.index < 0 || this.items.length === 0) return false;
    const direction = offset < 0 ? -1 : 1;
    let remaining = Math.max(1, Math.abs(offset));
    let next = this.index;
    while (remaining > 0) {
      const candidate = nextEnabled(this.items, next, direction);
      if (candidate === next) break;
      next = candidate;
      remaining -= 1;
    }
    return this.moveTo(next);
  }

  private moveTo(index: number): boolean {
    if (index < 0 || index === this.index) return false;
    this.index = index;
    return true;
  }
}

function firstEnabled<T>(items: readonly SelectItem<T>[], start: number): number {
  for (let index = clamp(start, 0, Math.max(0, items.length - 1)); index < items.length; index++) {
    if (items[index]!.disabled !== true) return index;
  }
  for (let index = 0; index < start && index < items.length; index++) {
    if (items[index]!.disabled !== true) return index;
  }
  return -1;
}

function lastEnabled<T>(items: readonly SelectItem<T>[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]!.disabled !== true) return index;
  }
  return -1;
}

function nextEnabled<T>(
  items: readonly SelectItem<T>[],
  current: number,
  direction: -1 | 1,
): number {
  for (let index = current + direction; index >= 0 && index < items.length; index += direction) {
    if (items[index]!.disabled !== true) return index;
  }
  return current;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
