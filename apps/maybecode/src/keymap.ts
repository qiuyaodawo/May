import { Keymap, type KeyBindingDefinition } from "@may/keybindings";

export const MAYBECODE_KEY_ACTIONS = [
  "app.interrupt",
  "app.tools.toggle",
  "app.thinking.toggle",
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
] as const;

export type MaybeCodeKeyAction = typeof MAYBECODE_KEY_ACTIONS[number];

export const MAYBECODE_DEFAULT_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  { context: "global", keys: "ctrl+c", action: "app.interrupt" },
  { context: "global", keys: "<leader> d", action: "app.tools.toggle" },
  { context: "global", keys: "<leader> t", action: "app.thinking.toggle" },
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

  { context: "sessionSearch", keys: "escape", action: "list.cancel" },
  { context: "sessionSearch", keys: "enter", action: "search.finish" },
  { context: "sessionSearch", keys: "backspace", action: "text.backspace" },
  { context: "sessionSearch", keys: "ctrl+u", action: "text.clear" },

  { context: "sessionRename", keys: "escape", action: "list.cancel" },
  { context: "sessionRename", keys: "enter", action: "session.rename.accept" },
  { context: "sessionRename", keys: "backspace", action: "text.backspace" },
  { context: "sessionRename", keys: "ctrl+u", action: "text.clear" },

  { context: "sessionDelete", keys: "y", action: "session.delete.accept" },
  { context: "sessionDelete", keys: "n", action: "session.delete.cancel" },
  { context: "sessionDelete", keys: "escape", action: "session.delete.cancel" },
];

export function createMaybeCodeKeymap(): Keymap {
  return new Keymap(MAYBECODE_DEFAULT_KEYBINDINGS, {
    actions: MAYBECODE_KEY_ACTIONS,
    leader: "ctrl+x",
  });
}
