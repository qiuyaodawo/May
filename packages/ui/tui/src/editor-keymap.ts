import {
  Keymap,
  mergeKeyBindings,
  type KeyBindingDefinition,
} from "@may/keybindings";

export const EDITOR_ACTIONS = {
  left: "editor.left",
  right: "editor.right",
  up: "editor.up",
  down: "editor.down",
  lineStart: "editor.line.start",
  lineEnd: "editor.line.end",
  start: "editor.start",
  end: "editor.end",
  wordLeft: "editor.word.left",
  wordRight: "editor.word.right",
  selectLeft: "editor.select.left",
  selectRight: "editor.select.right",
  selectUp: "editor.select.up",
  selectDown: "editor.select.down",
  selectLineStart: "editor.select.line.start",
  selectLineEnd: "editor.select.line.end",
  selectStart: "editor.select.start",
  selectEnd: "editor.select.end",
  selectWordLeft: "editor.select.word.left",
  selectWordRight: "editor.select.word.right",
  selectAll: "editor.select.all",
  copy: "editor.copy",
  cut: "editor.cut",
  paste: "editor.paste",
  backspace: "editor.backspace",
  delete: "editor.delete",
  deleteWord: "editor.delete.word",
  submit: "editor.submit",
  newline: "editor.newline",
  tab: "editor.tab",
} as const;

export type EditorAction = typeof EDITOR_ACTIONS[keyof typeof EDITOR_ACTIONS];

export const DEFAULT_EDITOR_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  bind("left", EDITOR_ACTIONS.left),
  bind("right", EDITOR_ACTIONS.right),
  bind("up", EDITOR_ACTIONS.up),
  bind("down", EDITOR_ACTIONS.down),
  bind("home", EDITOR_ACTIONS.lineStart),
  bind("end", EDITOR_ACTIONS.lineEnd),
  bind("ctrl+e", EDITOR_ACTIONS.lineEnd),
  bind("ctrl+home", EDITOR_ACTIONS.start),
  bind("ctrl+end", EDITOR_ACTIONS.end),
  bind("ctrl+left", EDITOR_ACTIONS.wordLeft),
  bind("alt+left", EDITOR_ACTIONS.wordLeft),
  bind("ctrl+right", EDITOR_ACTIONS.wordRight),
  bind("alt+right", EDITOR_ACTIONS.wordRight),
  bind("shift+left", EDITOR_ACTIONS.selectLeft),
  bind("shift+right", EDITOR_ACTIONS.selectRight),
  bind("shift+up", EDITOR_ACTIONS.selectUp),
  bind("shift+down", EDITOR_ACTIONS.selectDown),
  bind("shift+home", EDITOR_ACTIONS.selectLineStart),
  bind("shift+end", EDITOR_ACTIONS.selectLineEnd),
  bind("ctrl+shift+home", EDITOR_ACTIONS.selectStart),
  bind("ctrl+shift+end", EDITOR_ACTIONS.selectEnd),
  bind("ctrl+shift+left", EDITOR_ACTIONS.selectWordLeft),
  bind("alt+shift+left", EDITOR_ACTIONS.selectWordLeft),
  bind("ctrl+shift+right", EDITOR_ACTIONS.selectWordRight),
  bind("alt+shift+right", EDITOR_ACTIONS.selectWordRight),
  bind("ctrl+a", EDITOR_ACTIONS.selectAll),
  bind("ctrl+c", EDITOR_ACTIONS.copy, "editor.selection"),
  bind("ctrl+x", EDITOR_ACTIONS.cut, "editor.selection"),
  bind("ctrl+v", EDITOR_ACTIONS.paste),
  bind("shift+insert", EDITOR_ACTIONS.paste),
  bind("backspace", EDITOR_ACTIONS.backspace),
  bind("delete", EDITOR_ACTIONS.delete),
  bind("ctrl+w", EDITOR_ACTIONS.deleteWord),
  bind("ctrl+backspace", EDITOR_ACTIONS.deleteWord),
  bind("alt+backspace", EDITOR_ACTIONS.deleteWord),
  bind("enter", EDITOR_ACTIONS.submit),
  bind("shift+enter", EDITOR_ACTIONS.newline),
  bind("tab", EDITOR_ACTIONS.tab),
];

export function createEditorKeymap(
  overrides: readonly KeyBindingDefinition[] = [],
): Keymap {
  const actions = new Set<string>(Object.values(EDITOR_ACTIONS));
  for (const binding of overrides) {
    if (binding.context !== "editor" && binding.context !== "editor.selection") {
      throw new Error(`Unknown editor keybinding context: ${binding.context}`);
    }
    if (!actions.has(binding.action)) {
      throw new Error(`Unknown editor keybinding action: ${binding.action}`);
    }
  }
  return new Keymap(mergeKeyBindings(DEFAULT_EDITOR_KEYBINDINGS, overrides), { actions: [...actions] });
}

function bind(keys: string, action: EditorAction, context = "editor"): KeyBindingDefinition {
  return { keys, action, context };
}
