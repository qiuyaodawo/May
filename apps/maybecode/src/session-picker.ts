import type { KeyStroke } from "@may/keybindings";
import { sanitizeTerminalText } from "@may/tui";

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
  let sessions = [...options.sessions];
  let mode: PickerMode = "browse";
  let query = "";
  let renameText = "";
  let selectedIndex = 0;
  let preview = false;
  let notice: string | undefined;

  try {
    while (true) {
      const visible = filterSessions(sessions, query);
      selectedIndex = clampIndex(selectedIndex, visible.length);
      const selected = visible[selectedIndex];
      options.terminal.renderView(sanitizeTerminalText(renderSessionPicker({
        sessions: visible,
        selectedIndex,
        currentSessionId: options.controller.sessionId,
        mode,
        query,
        renameText,
        preview,
        ...(notice === undefined ? {} : { notice }),
      })));
      notice = undefined;

      const stroke = await options.terminal.readKey();
      const action = resolvePickerAction(keymap, stroke, mode);
      if (action === undefined) {
        const text = printableText(stroke);
        if (text !== undefined && mode === "search") {
          query += text;
          selectedIndex = 0;
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
            sessions = [...await options.controller.listSessions()];
            selectedIndex = clampIndex(selectedIndex, sessions.length);
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
          renameText = removeLastCharacter(renameText);
        } else if (action === "text.clear") {
          renameText = "";
        } else if (
          action === "session.rename.accept" && selected !== undefined
        ) {
          try {
            await options.controller.renameSession(selected.id, renameText);
            sessions = [...await options.controller.listSessions()];
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
          query = "";
          selectedIndex = 0;
          mode = "browse";
          keymap.reset();
        } else if (action === "search.finish") {
          mode = "browse";
          keymap.reset();
        } else if (action === "text.backspace") {
          query = removeLastCharacter(query);
          selectedIndex = 0;
        } else if (action === "text.clear") {
          query = "";
          selectedIndex = 0;
        } else {
          selectedIndex = moveSelection(action, selectedIndex, visible.length);
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
          selectedIndex = moveSelection(action, selectedIndex, visible.length);
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
  const numeric = Number(answer);
  const selected = Number.isSafeInteger(numeric) && numeric > 0
    ? options.sessions[numeric - 1]
    : options.sessions.find((session) => session.id === answer);
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

function moveSelection(
  action: MaybeCodeKeyAction,
  current: number,
  count: number,
): number {
  if (count === 0) return 0;
  switch (action) {
    case "list.up":
      return current === 0 ? count - 1 : current - 1;
    case "list.down":
      return current === count - 1 ? 0 : current + 1;
    case "list.pageUp":
      return Math.max(0, current - 10);
    case "list.pageDown":
      return Math.min(count - 1, current + 10);
    case "list.home":
      return 0;
    case "list.end":
      return count - 1;
    default:
      return current;
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

function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): readonly SessionSummary[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return sessions;
  return sessions.filter((session) =>
    [session.id, sessionLabel(session), session.preview]
      .some((value) => value?.toLowerCase().includes(normalized) === true)
  );
}

function sessionLabel(session: SessionSummary): string {
  return session.title ?? "Untitled session";
}

function clampIndex(index: number, count: number): number {
  return count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
}

function printableText(stroke: KeyStroke): string | undefined {
  if (stroke.ctrl || stroke.alt || stroke.meta) return undefined;
  return stroke.text !== undefined && stroke.text.length > 0
    ? stroke.text
    : undefined;
}

function removeLastCharacter(value: string): string {
  return [...value].slice(0, -1).join("");
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
