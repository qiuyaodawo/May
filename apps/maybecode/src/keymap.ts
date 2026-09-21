import { Keymap, formatKeySequence, mergeKeyBindings, parseKeySequence, type KeyBindingDefinition } from "@may/keybindings";
import { DEFAULT_EDITOR_KEYBINDINGS } from "@may/tui";

export const MAYBECODE_KEY_ACTIONS = [
  "app.interrupt",
  "app.tools.toggle",
  "app.thinking.toggle",
  "app.reply.start",
  "app.focus.next",
  "app.focus.previous",
  "app.selection.copy",
  "list.up",
  "list.down",
  "list.pageUp",
  "list.pageDown",
  "list.home",
  "list.end",
  "list.accept",
  "list.cancel",
  "preview.toggle",
  "search.start",
  "search.finish",
  "text.backspace",
  "text.clear",
  "session.rename.start",
  "session.rename.accept",
  "session.delete.request",
  "session.delete.accept",
  "session.delete.cancel",
  "model.default.set",
  "approval.allow",
  "approval.allowSession",
  "approval.deny",
  "request.cancel",
  "request.pageUp",
  "request.pageDown",
  "request.scrollUp",
  "request.scrollDown",
] as const;

export type MaybeCodeKeyAction = typeof MAYBECODE_KEY_ACTIONS[number];

export const MAYBECODE_DEFAULT_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  { context: "global", keys: "ctrl+c", action: "app.interrupt" },
  { context: "dialog", keys: "ctrl+c", action: "app.interrupt" },
  { context: "global", keys: "<leader> d", action: "app.tools.toggle" },
  { context: "global", keys: "<leader> t", action: "app.thinking.toggle" },
  { context: "global", keys: "<leader> r", action: "app.reply.start" },
  { context: "global", keys: "tab", action: "app.focus.next" },
  { context: "global", keys: "shift+tab", action: "app.focus.previous" },
  { context: "transcript.selection", keys: "ctrl+c", action: "app.selection.copy" },
  { context: "select", keys: "up", action: "list.up" },
  { context: "select", keys: "down", action: "list.down" },
  { context: "select", keys: "pageup", action: "list.pageUp" },
  { context: "select", keys: "pagedown", action: "list.pageDown" },
  { context: "select", keys: "home", action: "list.home" },
  { context: "select", keys: "end", action: "list.end" },
  { context: "select", keys: "enter", action: "list.accept" },
  { context: "select", keys: "escape", action: "list.cancel" },

  { context: "sessionPicker", keys: "space", action: "preview.toggle" },
  { context: "sessionPicker", keys: "/", action: "search.start" },
  { context: "sessionPicker", keys: "d", action: "session.delete.request" },
  { context: "sessionPicker", keys: "r", action: "session.rename.start" },

  { context: "modelPicker", keys: "d", action: "model.default.set" },

  { context: "approval", keys: "a", action: "approval.allow" },
  { context: "approval", keys: "s", action: "approval.allowSession" },
  { context: "approval", keys: "d", action: "approval.deny" },

  { context: "mcpInput", keys: "escape", action: "request.cancel" },
  { context: "mcpInput", keys: "pageup", action: "request.pageUp" },
  { context: "mcpInput", keys: "pagedown", action: "request.pageDown" },
  { context: "mcpInput", keys: "wheelup", action: "request.scrollUp" },
  { context: "mcpInput", keys: "wheeldown", action: "request.scrollDown" },

  { context: "sessionSearch", keys: "escape", action: "list.cancel" },
  { context: "sessionSearch", keys: "enter", action: "search.finish" },
  { context: "sessionSearch", keys: "backspace", action: "text.backspace" },
  { context: "sessionSearch", keys: "ctrl+u", action: "text.clear" },
  { context: "sessionSearch", keys: "up", action: "list.up" },
  { context: "sessionSearch", keys: "down", action: "list.down" },
  { context: "sessionSearch", keys: "pageup", action: "list.pageUp" },
  { context: "sessionSearch", keys: "pagedown", action: "list.pageDown" },

  { context: "sessionRename", keys: "escape", action: "list.cancel" },
  { context: "sessionRename", keys: "enter", action: "session.rename.accept" },
  { context: "sessionRename", keys: "backspace", action: "text.backspace" },
  { context: "sessionRename", keys: "ctrl+u", action: "text.clear" },

  { context: "sessionDelete", keys: "y", action: "session.delete.accept" },
  { context: "sessionDelete", keys: "n", action: "session.delete.cancel" },
  { context: "sessionDelete", keys: "escape", action: "session.delete.cancel" },
];

export interface MaybeCodeKeymapOptions {
  readonly leader?: string;
  readonly bindings?: readonly KeyBindingDefinition[];
}

export function createMaybeCodeKeymap(options: MaybeCodeKeymapOptions = {}): Keymap {
  const leader = options.leader ?? "ctrl+g";
  const sequence = parseKeySequence(leader);
  if (sequence.length !== 1 || (!sequence[0]!.ctrl && !sequence[0]!.alt && !sequence[0]!.meta)) {
    throw new Error("MaybeCode leader must be one modified key, for example ctrl+g");
  }
  const leaderKey = formatKeySequence(sequence);
  if (DEFAULT_EDITOR_KEYBINDINGS.some(binding =>
    formatKeySequence(parseKeySequence(binding.keys)) === leaderKey)) {
    throw new Error("MaybeCode leader conflicts with a text editing shortcut");
  }
  return new Keymap(mergeKeyBindings(MAYBECODE_DEFAULT_KEYBINDINGS, options.bindings, { leader }), {
    actions: MAYBECODE_KEY_ACTIONS,
    leader,
    chordTimeoutMs: null,
  });
}
