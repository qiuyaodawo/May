import type { KeyStroke, Keymap } from "@sortedyuan/tui/keybindings";
import {
  Column,
  Editor,
  SelectList,
  Text,
  sanitizeTerminalText,
  type Component,
  type InteractiveComponent,
  type RenderResult,
  type RenderSize,
  type TuiTheme,
  type PointerEvent,
  type EditorOptions,
} from "@sortedyuan/tui";
import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import { createMaybeCodeKeymap, type MaybeCodeKeymapOptions } from "../keymap.js";
import type { SessionDialogAction } from "./terminal-view.js";
import { promptShortcut } from "./terminal-prompts.js";

type SessionMode = "browse" | "search" | "rename" | "delete";

export class SessionPrompt implements InteractiveComponent {
  private mode: SessionMode = "browse";
  private query = "";
  private status = "";
  private readonly list: SelectList<SessionSummary>;
  private readonly input: Editor;
  private readonly keymap: Keymap;
  private readonly layout = new Column([], { gap: 1 });
  private readonly listRegion: Component = {
    render: (size) => this.list.render(size),
    handlePointer: (event) => (this.mode === "browse" || this.mode === "search") && this.list.handlePointer(event),
  };

  constructor(
    private readonly sessions: readonly SessionSummary[],
    private readonly currentSessionId: string,
    private readonly theme: TuiTheme,
    private readonly complete: (action: SessionDialogAction | undefined) => void,
    editorOptions: Pick<EditorOptions, "clipboard" | "onInvalidate" | "onError" | "keybindings">,
    keymapOptions: MaybeCodeKeymapOptions = {},
  ) {
    this.keymap = createMaybeCodeKeymap(keymapOptions);
    this.list = new SelectList<SessionSummary>([], {
      onSelect: () => this.resumeSelected(),
      onCancel: () => this.complete(undefined),
      selectedStyle: this.theme.selected,
      descriptionStyle: this.theme.muted,
      markerStyle: this.theme.accent,
      emptyLabel: "No matching sessions",
    });
    this.list.setFocused(true);
    this.input = new Editor({
      ...editorOptions,
      prompt: "> ",
      onChange: (value) => {
        if (this.mode !== "search") return;
        this.query = value;
        this.refreshList();
      },
      onSubmit: (value) => {
        if (this.mode !== "rename") return;
        const session = this.list.selectedItem?.value;
        const title = value.replace(/\s+/gu, " ").trim();
        if (session === undefined || title === "") {
          this.status = "Session title cannot be empty";
          return;
        }
        this.complete({ type: "rename", sessionId: session.id, title });
      },
    });
    this.refreshList();
  }

  render(size: RenderSize): RenderResult {
    this.layout.setItems([
      { height: 1, component: new Text(this.heading()) },
      { flex: 1, minHeight: 1, component: this.listRegion },
      { height: 2, component: this.footer() },
    ]);
    return this.layout.render(size);
  }

  handlePointer(event: PointerEvent): boolean {
    return this.layout.handlePointer(event);
  }

  dispose(): void {
    this.input.dispose();
  }

  handleKey(stroke: KeyStroke): boolean {
    const contexts =
      this.mode === "browse"
        ? ["select", "sessionPicker"]
        : [this.mode === "search" ? "sessionSearch" : this.mode === "rename" ? "sessionRename" : "sessionDelete"];
    const result = this.keymap.resolve(stroke, contexts);
    if (result.type === "pending") return true;
    if (result.type === "action") {
      switch (result.action) {
        case "list.cancel":
          if (this.mode !== "browse") return this.setMode("browse");
          this.complete(undefined);
          return true;
        case "list.up":
        case "list.down":
        case "list.pageUp":
        case "list.pageDown":
        case "list.home":
        case "list.end":
        case "list.accept":
          return this.list.performAction(result.action);
        case "search.start":
          this.setMode("search");
          this.status = "Type to filter by id, title, or preview";
          this.input.setValue("");
          return true;
        case "search.finish":
          return this.resumeSelected();
        case "session.rename.start":
          return this.beginRename();
        case "session.rename.accept":
          this.input.performAction("editor.submit");
          return true;
        case "session.delete.request":
          return this.beginDelete();
        case "session.delete.cancel":
          return this.setMode("browse");
        case "session.delete.accept":
          return this.deleteSelected();
        case "text.clear":
          this.input.setValue("");
          return true;
        case "text.backspace":
          this.input.performAction("editor.backspace");
          return true;
      }
    }
    return (this.mode === "search" || this.mode === "rename") && this.input.handleKey(stroke);
  }

  private footer(): InteractiveComponent {
    if (this.mode === "search" || this.mode === "rename") return this.input;
    return {
      render: (size) =>
        new Text(
          this.mode === "delete"
            ? `${this.status}\n${promptShortcut(this.keymap, "session.delete.accept", "sessionDelete")} delete / ${promptShortcut(this.keymap, "session.delete.cancel", "sessionDelete")} cancel`
            : `${this.status}\n${promptShortcut(this.keymap, "list.accept", "select")} resume · ${promptShortcut(this.keymap, "search.start", "sessionPicker")} search · ${promptShortcut(this.keymap, "session.rename.start", "sessionPicker")} rename · ${promptShortcut(this.keymap, "session.delete.request", "sessionPicker")} delete · ${promptShortcut(this.keymap, "list.cancel", "select")} close`,
        ).render(size),
      handleKey: () => false,
    };
  }

  private heading(): string {
    if (this.mode === "search") return `Search sessions: ${this.query || "…"}`;
    if (this.mode === "rename") return "Rename selected session";
    if (this.mode === "delete") return "Delete selected session?";
    return `${this.sessions.length} session${this.sessions.length === 1 ? "" : "s"}`;
  }

  private refreshList(): void {
    const query = this.query.trim().toLowerCase();
    const filtered =
      query === ""
        ? this.sessions
        : this.sessions.filter((session) =>
            [session.id, session.title, session.preview]
              .filter((value): value is string => value !== undefined)
              .some((value) => value.toLowerCase().includes(query)),
          );
    this.list.setItems(
      filtered.map((session) => ({
        value: session,
        label: `${session.id === this.currentSessionId ? "* " : ""}${session.title ?? session.id}`,
        description:
          session.preview ?? (session.turnCount === undefined ? "No recorded turns" : `${session.turnCount} turns`),
      })),
    );
    this.status = filtered.length === 0 ? "No matching sessions" : this.status;
  }

  private resumeSelected(): boolean {
    const session = this.list.selectedItem?.value;
    if (session === undefined) return false;
    this.complete({ type: "resume", sessionId: session.id });
    return true;
  }

  private beginRename(): boolean {
    const session = this.list.selectedItem?.value;
    if (session === undefined) return false;
    this.setMode("rename");
    this.status = "Enter a new title";
    this.input.setValue(session.title ?? "");
    return true;
  }

  private beginDelete(): boolean {
    const session = this.list.selectedItem?.value;
    if (session === undefined) return false;
    if (session.id === this.currentSessionId) {
      this.status = "The active session cannot be deleted";
      return true;
    }
    this.setMode("delete");
    this.status = `Delete ${sanitizeTerminalText(session.title ?? session.id)}?`;
    return true;
  }

  private deleteSelected(): boolean {
    const session = this.list.selectedItem?.value;
    if (session === undefined || session.id === this.currentSessionId) {
      return this.setMode("browse");
    }
    this.complete({ type: "delete", sessionId: session.id });
    return true;
  }

  private setMode(mode: SessionMode): boolean {
    const resetSearch = this.mode === "search" && mode !== "search";
    this.mode = mode;
    this.status = "";
    this.keymap.reset();
    this.input.resetKeybindings();
    this.input.setFocused(mode === "search" || mode === "rename");
    this.list.setFocused(false);
    this.list.setFocused(mode === "browse" || mode === "search");
    if (resetSearch) {
      this.query = "";
      this.refreshList();
    }
    return true;
  }
}
