import { Keymap, mergeKeyBindings, type KeyStroke, type KeyBindingDefinition } from "@may/keybindings";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type {
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
  PointerEvent,
} from "./component.js";
import { styleText, type TextStyle } from "./theme.js";
import { sanitizeTerminalText } from "./text.js";

export interface SelectItem<T = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SelectListOptions<T> {
  readonly keybindings?: readonly KeyBindingDefinition[];
  readonly selectedIndex?: number;
  readonly emptyLabel?: string;
  readonly onSelect?: (item: SelectItem<T>, index: number) => void;
  readonly onCancel?: () => void;
  readonly selectedStyle?: TextStyle;
  readonly descriptionStyle?: TextStyle;
  readonly disabledStyle?: TextStyle;
  readonly markerStyle?: TextStyle;
}

export const SELECT_LIST_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  { context: "select", keys: "up", action: "list.up" },
  { context: "select", keys: "down", action: "list.down" },
  { context: "select", keys: "pageup", action: "list.pageUp" },
  { context: "select", keys: "pagedown", action: "list.pageDown" },
  { context: "select", keys: "home", action: "list.home" },
  { context: "select", keys: "end", action: "list.end" },
  { context: "select", keys: "enter", action: "list.accept" },
  { context: "select", keys: "escape", action: "list.cancel" },
];

export class SelectList<T = string>
  implements InteractiveComponent, FocusTarget {
  private items: readonly SelectItem<T>[];
  private index: number;
  private offset = 0;
  private pageSize = 1;
  private focused = false;
  private readonly keymap: Keymap;

  constructor(
    items: readonly SelectItem<T>[],
    private readonly options: SelectListOptions<T> = {},
  ) {
    this.items = [...items];
    this.index = firstEnabled(this.items, options.selectedIndex ?? 0);
    this.keymap = new Keymap(mergeKeyBindings(SELECT_LIST_KEYBINDINGS, options.keybindings), {
      actions: SELECT_LIST_KEYBINDINGS.map(binding => binding.action),
    });
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
    if (focused !== this.focused) this.keymap.reset();
    this.focused = focused;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused) return false;
    const result = this.keymap.resolve(stroke, ["select"]);
    if (result.type !== "action") return result.type === "pending";
    return this.performAction(result.action);
  }

  performAction(action: string): boolean {
    switch (action) {
      case "list.up": this.move(-1); return true;
      case "list.down": this.move(1); return true;
      case "list.pageUp": this.move(-this.pageSize); return true;
      case "list.pageDown": this.move(this.pageSize); return true;
      case "list.home": this.moveTo(firstEnabled(this.items, 0)); return true;
      case "list.end": this.moveTo(lastEnabled(this.items)); return true;
      case "list.accept": {
        const item = this.selectedItem;
        if (item === undefined) return false;
        this.options.onSelect?.(item, this.index);
        return true;
      }
      case "list.cancel":
        this.options.onCancel?.();
        return this.options.onCancel !== undefined;
      default:
        return false;
    }
  }

  handlePointer(event: PointerEvent): boolean {
    if (event.button !== 0 || event.type !== "down" || event.y < 0 || event.y >= this.pageSize) return false;
    const index = this.offset + event.y;
    if (this.items[index] === undefined || this.items[index]!.disabled) return false;
    this.moveTo(index);
    return true;
  }

  render(size: RenderSize): RenderResult {
    if (this.items.length === 0) {
      return {
        lines: [sliceAnsi(
          sanitizeTerminalText(this.options.emptyLabel ?? "No items"),
          0,
          size.width,
        )],
      };
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
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
