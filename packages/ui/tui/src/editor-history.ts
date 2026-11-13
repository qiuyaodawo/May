/** @experimental */
export interface EditorHistoryOptions {
  readonly entries?: readonly string[];
  readonly maximumEntries?: number;
}

/**
 * In-process command history that can be shared with or replaced by a UI.
 * @experimental
 */
export class EditorHistory {
  private readonly maximumEntries: number;
  private entries: string[];
  private index: number;
  private draft = "";

  constructor(options: EditorHistoryOptions = {}) {
    this.maximumEntries = positiveInteger(options.maximumEntries ?? 100, "maximumEntries");
    this.entries = (options.entries ?? [])
      .map(normalizeValue)
      .filter((value) => value.trim() !== "")
      .slice(-this.maximumEntries);
    this.index = this.entries.length;
  }

  get values(): readonly string[] {
    return [...this.entries];
  }

  record(value: string): void {
    const normalized = normalizeValue(value);
    if (normalized.trim() !== "" && this.entries.at(-1) !== normalized) {
      this.entries.push(normalized);
      if (this.entries.length > this.maximumEntries) {
        this.entries.splice(0, this.entries.length - this.maximumEntries);
      }
    }
    this.reset();
  }

  previous(current: string): string | undefined {
    if (this.entries.length === 0 || this.index === 0) return undefined;
    if (this.index === this.entries.length) this.draft = current;
    this.index -= 1;
    return this.entries[this.index];
  }

  next(): string | undefined {
    if (this.index >= this.entries.length) return undefined;
    this.index += 1;
    return this.index === this.entries.length ? this.draft : this.entries[this.index];
  }

  reset(): void {
    this.index = this.entries.length;
    this.draft = "";
  }
}

export function normalizeValue(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
