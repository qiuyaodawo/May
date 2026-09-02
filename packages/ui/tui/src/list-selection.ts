import type { KeyStroke } from "@may/keybindings";

export type ListNavigationAction =
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "home"
  | "end";

export interface ListSelectionOptions<Item> {
  readonly initialIndex?: number;
  readonly pageSize?: number;
  readonly filter?: (item: Item, normalizedQuery: string) => boolean;
}

/** Reusable selection and search state for retained or line-oriented pickers. */
export class ListSelectionModel<Item> {
  private source: Item[];
  private readonly pageSize: number;
  private readonly filter: ((item: Item, normalizedQuery: string) => boolean) | undefined;
  private queryValue = "";
  private index: number;

  constructor(items: readonly Item[], options: ListSelectionOptions<Item> = {}) {
    this.source = [...items];
    this.pageSize = positiveInteger(options.pageSize ?? 10, "pageSize");
    this.filter = options.filter;
    this.index = clampListIndex(options.initialIndex ?? 0, this.items.length);
  }

  get query(): string {
    return this.queryValue;
  }

  get items(): readonly Item[] {
    const normalized = this.queryValue.trim().toLowerCase();
    return normalized === "" || this.filter === undefined
      ? this.source
      : this.source.filter((item) => this.filter!(item, normalized));
  }

  get selectedIndex(): number {
    return this.index;
  }

  get selected(): Item | undefined {
    return this.items[this.index];
  }

  setItems(items: readonly Item[]): void {
    this.source = [...items];
    this.index = clampListIndex(this.index, this.items.length);
  }

  setQuery(query: string): void {
    this.queryValue = query;
    this.index = 0;
  }

  appendQuery(text: string): void {
    if (text === "") return;
    this.setQuery(this.queryValue + text);
  }

  backspaceQuery(): void {
    this.setQuery(removeLastCodePoint(this.queryValue));
  }

  clearQuery(): void {
    this.setQuery("");
  }

  move(action: ListNavigationAction): void {
    const count = this.items.length;
    if (count === 0) {
      this.index = 0;
      return;
    }
    switch (action) {
      case "up":
        this.index = this.index === 0 ? count - 1 : this.index - 1;
        break;
      case "down":
        this.index = this.index === count - 1 ? 0 : this.index + 1;
        break;
      case "page-up":
        this.index = Math.max(0, this.index - this.pageSize);
        break;
      case "page-down":
        this.index = Math.min(count - 1, this.index + this.pageSize);
        break;
      case "home":
        this.index = 0;
        break;
      case "end":
        this.index = count - 1;
        break;
    }
  }
}

export function resolveListInput<Item>(
  items: readonly Item[],
  input: string,
  value: (item: Item) => string,
): Item | undefined {
  const numeric = Number(input);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? items[numeric - 1]
    : items.find((item) => value(item) === input);
}

export function printableKeyText(stroke: KeyStroke): string | undefined {
  if (stroke.ctrl || stroke.alt || stroke.meta) return undefined;
  return stroke.text !== undefined && stroke.text.length > 0
    ? stroke.text
    : undefined;
}

export function clampListIndex(index: number, count: number): number {
  return count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
}

export function removeLastCodePoint(value: string): string {
  return [...value].slice(0, -1).join("");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
