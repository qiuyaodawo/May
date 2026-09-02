import type { KeyStroke } from "@may/keybindings";
import { sanitizeTerminalText } from "@may/tui";
import {
  ListSelectionModel,
  printableKeyText,
  removeLastCodePoint,
  resolveListInput,
  type ListNavigationAction,
} from "@may/tui/list-selection";

import type { SessionSummary } from "@may/session/catalog";
import type { MaybeCodeController } from "./controller.js";
import { createMaybeCodeKeymap, type MaybeCodeKeyAction } from "./keymap.js";
import type { TerminalIO } from "@may/tui/node-terminal";

type PickerMode = "browse" | "search" | "rename" | "delete";

export type SessionPickerResult =
  | { readonly type: "cancelled" }
  | { readonly type: "empty" }
  | { readonly type: "resume"; readonly sessionId: string };

export interface SessionPickerOptions {
  readonly controller: MaybeCodeController;
  readonly terminal: TerminalIO;
  readonly sessions: readonly SessionSummary[];
  readonly question: (prompt: string) => Promise<string>;
}

export async function runSessionPicker(
  options: SessionPickerOptions,
): Promise<SessionPickerResult> {
  if (options.sessions.length === 0) return { type: "empty" };
  if (
    options.terminal.interactive !== true ||
    options.terminal.readKey === undefined ||
    options.terminal.renderView === undefined ||
    options.terminal.closeView === undefined
  ) {
    return runLineSessionPicker(options);
  }

  const keymap = createMaybeCodeKeymap();
  const selection = new ListSelectionModel(options.sessions, {
    pageSize: 10,
    filter: sessionMatches,
  });
  let mode: PickerMode = "browse";
  let renameText = "";
  let preview = false;
  let notice: string | undefined;

  try {
    while (true) {
      const visible = selection.items;
      const selected = selection.selected;
      options.terminal.renderView(sanitizeTerminalText(renderSessionPicker({
        sessions: visible,
        selectedIndex: selection.selectedIndex,
        currentSessionId: options.controller.sessionId,
        mode,
        query: selection.query,
        renameText,
        preview,
        ...(notice === undefined ? {} : { notice }),
      })));
      notice = undefined;

      const stroke = await options.terminal.readKey();
      const action = resolvePickerAction(keymap, stroke, mode);
      if (action === undefined) {
        const text = printableKeyText(stroke);
        if (text !== undefined && mode === "search") {
          selection.appendQuery(text);
        } else if (text !== undefined && mode === "rename") {
          renameText += text;
        }
        continue;
      }

      if (action === "app.interrupt") return { type: "cancelled" };
      if (mode === "delete") {
        if (action === "session.delete.cancel") {
          mode = "browse";
          keymap.reset();
        } else if (action === "session.delete.accept" && selected !== undefined) {
          try {
            const removed = await options.controller.deleteSession(selected.id);
            selection.setItems(await options.controller.listSessions());
            notice = removed
              ? `Deleted ${sessionLabel(selected)}`
              : `Session ${selected.id} no longer exists`;
          } catch (error) {
            notice = errorMessage(error);
          }
          mode = "browse";
          keymap.reset();
        }
        continue;
      }

      if (mode === "rename") {
        if (action === "list.cancel") {
          mode = "browse";
          renameText = "";
          keymap.reset();
        } else if (action === "text.backspace") {
          renameText = removeLastCodePoint(renameText);
        } else if (action === "text.clear") {
          renameText = "";
        } else if (
          action === "session.rename.accept" && selected !== undefined
        ) {
          try {
            await options.controller.renameSession(selected.id, renameText);
            selection.setItems(await options.controller.listSessions());
            notice = `Renamed session to ${renameText.trim()}`;
            mode = "browse";
            renameText = "";
          } catch (error) {
            notice = errorMessage(error);
          }
          keymap.reset();
        }
        continue;
      }

      if (mode === "search") {
        if (action === "list.cancel") {
          selection.clearQuery();
          mode = "browse";
          keymap.reset();
        } else if (action === "search.finish") {
          mode = "browse";
          keymap.reset();
        } else if (action === "text.backspace") {
          selection.backspaceQuery();
        } else if (action === "text.clear") {
          selection.clearQuery();
        } else {
          const navigation = navigationAction(action);
          if (navigation !== undefined) selection.move(navigation);
        }
        continue;
      }

      switch (action) {
        case "list.cancel":
          return { type: "cancelled" };
        case "list.accept":
          if (selected !== undefined) {
            return { type: "resume", sessionId: selected.id };
          }
          break;
        case "preview.toggle":
          preview = !preview;
          break;
        case "search.start":
          mode = "search";
          keymap.reset();
          break;
        case "session.rename.start":
          if (selected !== undefined) {
            mode = "rename";
            renameText = selected.title ?? "";
            keymap.reset();
          }
          break;
        case "session.delete.request":
          if (selected?.id === options.controller.sessionId) {
            notice = "The active session cannot be deleted";
          } else if (selected !== undefined) {
            mode = "delete";
            keymap.reset();
          }
          break;
        default:
          {
            const navigation = navigationAction(action);
            if (navigation !== undefined) selection.move(navigation);
          }
      }
    }
  } finally {
    options.terminal.closeView();
  }
}

async function runLineSessionPicker(
  options: SessionPickerOptions,
): Promise<SessionPickerResult> {
  options.terminal.write(sanitizeTerminalText(`\n${renderLineSessionList(
    options.sessions,
    options.controller.sessionId,
  )}`));
  const answer = (await options.question(
    "Select a session number or ID (Enter to cancel): ",
  )).trim();
  if (answer === "") return { type: "cancelled" };
  const selected = resolveListInput(options.sessions, answer, (session) => session.id);
  if (selected === undefined) {
    throw new Error(`Unknown session selection: ${answer}`);
  }
  return { type: "resume", sessionId: selected.id };
}

function resolvePickerAction(
  keymap: ReturnType<typeof createMaybeCodeKeymap>,
  stroke: KeyStroke,
  mode: PickerMode,
): MaybeCodeKeyAction | undefined {
  const contexts = mode === "browse"
    ? ["global", "select", "sessionPicker"]
    : mode === "search"
    ? ["global", "select", "sessionSearch"]
    : mode === "rename"
    ? ["global", "sessionRename"]
    : ["global", "sessionDelete"];
  const result = keymap.resolve(stroke, contexts);
  return result.type === "action"
    ? result.action as MaybeCodeKeyAction
    : undefined;
}

function navigationAction(
  action: MaybeCodeKeyAction,
): ListNavigationAction | undefined {
  switch (action) {
    case "list.up":
      return "up";
    case "list.down":
      return "down";
    case "list.pageUp":
      return "page-up";
    case "list.pageDown":
      return "page-down";
    case "list.home":
      return "home";
    case "list.end":
      return "end";
    default:
      return undefined;
  }
}

interface RenderState {
  readonly sessions: readonly SessionSummary[];
  readonly selectedIndex: number;
  readonly currentSessionId: string;
  readonly mode: PickerMode;
  readonly query: string;
  readonly renameText: string;
  readonly preview: boolean;
  readonly notice?: string;
}

function renderSessionPicker(state: RenderState): string {
  const pageSize = 10;
  const start = Math.floor(state.selectedIndex / pageSize) * pageSize;
  const page = state.sessions.slice(start, start + pageSize);
  let output = "MaybeCode — Resume session\n\n";
  output += state.query === ""
    ? ""
    : `Filter: ${state.query}${state.mode === "search" ? "▌" : ""}\n\n`;
  if (page.length === 0) {
    output += "  No matching sessions.\n";
  } else {
    for (const [offset, session] of page.entries()) {
      const index = start + offset;
      const selected = index === state.selectedIndex ? ">" : " ";
      const current = session.id === state.currentSessionId ? " [current]" : "";
      output += `${selected} ${sessionLabel(session)}${current}\n`;
      output += `    ${relativeTime(session.lastUsedAt)} · ` +
        `${session.turnCount ?? 0} turns · ${session.id}\n`;
    }
  }

  const selected = state.sessions[state.selectedIndex];
  if (state.preview && selected !== undefined) {
    output += "\nPreview\n" +
      `  created: ${new Date(selected.createdAt).toLocaleString()}\n` +
      `  last used: ${new Date(selected.lastUsedAt).toLocaleString()}\n` +
      `  ${selected.preview ?? "No message preview available."}\n`;
  }
  if (state.mode === "rename") {
    output += `\nRename session\n  ${state.renameText}▌\n` +
      "  Enter save · Esc cancel · Ctrl+U clear\n";
  } else if (state.mode === "delete" && selected !== undefined) {
    output += `\nDelete “${sessionLabel(selected)}”? ` +
      "This also removes its durable history.\n  Y delete · N/Esc cancel\n";
  } else if (state.mode === "search") {
    output += "\nType to filter · Enter finish · Esc close and clear search\n";
  } else {
    output += "\n↑↓ move · Enter resume · / search · Space preview · " +
      "R rename · D delete · Esc close\n";
  }
  if (state.notice !== undefined) output += `\n${state.notice}\n`;
  return output;
}

function renderLineSessionList(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
): string {
  const lines = sessions.map((session, index) => {
    const current = session.id === currentSessionId ? " [current]" : "";
    return `  ${index + 1}. ${sessionLabel(session)}${current}\n` +
      `     ${relativeTime(session.lastUsedAt)} · ${session.id}`;
  });
  return `Resume a session:\n${lines.join("\n")}\n`;
}

function sessionMatches(session: SessionSummary, normalizedQuery: string): boolean {
  return [session.id, sessionLabel(session), session.preview]
    .some((value) => value?.toLowerCase().includes(normalizedQuery) === true);
}

function sessionLabel(session: SessionSummary): string {
  return session.title ?? "Untitled session";
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
