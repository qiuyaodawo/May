import type { KeyStroke } from "@may/keybindings";
import type { FocusTarget } from "./component.js";

interface FocusEntry {
  readonly id: string;
  readonly target: FocusTarget;
}

/** Explicit, UI-framework-level focus order without application globals. */
export class FocusManager {
  private readonly entries: FocusEntry[] = [];
  private activeId: string | undefined;

  get focusedId(): string | undefined {
    return this.activeId;
  }

  register(id: string, target: FocusTarget): () => void {
    if (id.trim() === "") throw new Error("Focus target id cannot be empty");
    if (this.entries.some((entry) => entry.id === id)) {
      throw new Error(`Duplicate focus target: ${id}`);
    }
    this.entries.push({ id, target });
    if (this.activeId === undefined) this.focus(id);
    else target.setFocused(false);
    return () => this.unregister(id);
  }

  focus(id: string): boolean {
    const next = this.entries.find((entry) => entry.id === id);
    if (next === undefined || this.activeId === id) return next !== undefined;
    this.current()?.target.setFocused(false);
    this.activeId = id;
    next.target.setFocused(true);
    return true;
  }

  focusNext(): boolean {
    return this.move(1);
  }

  focusPrevious(): boolean {
    return this.move(-1);
  }

  dispatch(stroke: KeyStroke): boolean {
    return this.current()?.target.handleKey(stroke) ?? false;
  }

  clear(): void {
    this.current()?.target.setFocused(false);
    this.entries.splice(0, this.entries.length);
    this.activeId = undefined;
  }

  private unregister(id: string): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const wasActive = this.activeId === id;
    this.entries[index]!.target.setFocused(false);
    this.entries.splice(index, 1);
    if (!wasActive) return;
    this.activeId = undefined;
    const next = this.entries[Math.min(index, this.entries.length - 1)];
    if (next !== undefined) this.focus(next.id);
  }

  private move(offset: number): boolean {
    if (this.entries.length === 0) return false;
    const currentIndex = this.entries.findIndex((entry) =>
      entry.id === this.activeId
    );
    const index = currentIndex < 0
      ? 0
      : (currentIndex + offset + this.entries.length) % this.entries.length;
    return this.focus(this.entries[index]!.id);
  }

  private current(): FocusEntry | undefined {
    return this.entries.find((entry) => entry.id === this.activeId);
  }
}
