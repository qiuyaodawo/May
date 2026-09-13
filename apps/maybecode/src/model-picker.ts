import type { KeyStroke } from "@may/keybindings";
import { sanitizeTerminalText } from "@may/tui";
import {
  ListSelectionModel,
  resolveListInput,
  type ListNavigationAction,
} from "@may/tui/list-selection";

import type {
  MaybeCodeController,
  MaybeCodeModelProfile,
} from "./controller.js";
import { createMaybeCodeKeymap, type MaybeCodeKeyAction } from "./keymap.js";
import type { TerminalIO } from "@may/tui/node-terminal";

export type ModelPickerResult =
  | { readonly type: "cancelled" }
  | { readonly type: "empty" }
  | { readonly type: "select"; readonly profile: string }
  | { readonly type: "set-default"; readonly profile: string };

export interface ModelPickerOptions {
  readonly controller: MaybeCodeController;
  readonly terminal: TerminalIO;
  readonly models: readonly MaybeCodeModelProfile[];
  readonly question: (prompt: string) => Promise<string>;
}

export async function runModelPicker(
  options: ModelPickerOptions,
): Promise<ModelPickerResult> {
  if (options.models.length === 0) return { type: "empty" };
  if (
    options.terminal.interactive !== true ||
    options.terminal.readKey === undefined ||
    options.terminal.renderView === undefined ||
    options.terminal.closeView === undefined
  ) {
    return runLineModelPicker(options);
  }

  const keymap = createMaybeCodeKeymap();
  const selection = new ListSelectionModel(options.models, {
    initialIndex: Math.max(
      0,
      options.models.findIndex((model) =>
        model.name === options.controller.modelInfo?.profile
      ),
    ),
    pageSize: 10,
  });
  try {
    while (true) {
      options.terminal.renderView(sanitizeTerminalText(renderModelPicker(
        options.models,
        selection.selectedIndex,
        options.controller.modelInfo?.profile,
      )));
      const action = resolvePickerAction(
        keymap,
        await options.terminal.readKey(),
      );
      if (action === "app.interrupt" || action === "list.cancel") {
        return { type: "cancelled" };
      }
      if (action === "list.accept") {
        return { type: "select", profile: selection.selected!.name };
      }
      if (action === "model.default.set") {
        return {
          type: "set-default",
          profile: selection.selected!.name,
        };
      }
      const navigation = navigationAction(action);
      if (navigation !== undefined) selection.move(navigation);
    }
  } finally {
    options.terminal.closeView();
  }
}

async function runLineModelPicker(
  options: ModelPickerOptions,
): Promise<ModelPickerResult> {
  options.terminal.write(sanitizeTerminalText(`\n${renderLineModelList(
    options.models,
    options.controller.modelInfo?.profile,
  )}`));
  const answer = (await options.question(
    "Select a model number/name, or d <selection> to set default (Enter to cancel): ",
  )).trim();
  if (answer === "") return { type: "cancelled" };
  const defaultMatch = /^d\s+(.+)$/iu.exec(answer);
  const selection = defaultMatch?.[1] ?? answer;
  const selected = resolveListInput(options.models, selection, (model) => model.name);
  if (selected === undefined) {
    throw new Error(`Unknown model selection: ${selection}`);
  }
  return {
    type: defaultMatch === null ? "select" : "set-default",
    profile: selected.name,
  };
}

function resolvePickerAction(
  keymap: ReturnType<typeof createMaybeCodeKeymap>,
  stroke: KeyStroke,
): MaybeCodeKeyAction | undefined {
  const result = keymap.resolve(stroke, ["global", "modelPicker", "select"]);
  return result.type === "action"
    ? result.action as MaybeCodeKeyAction
    : undefined;
}

function navigationAction(
  action: MaybeCodeKeyAction | undefined,
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

function renderModelPicker(
  models: readonly MaybeCodeModelProfile[],
  selectedIndex: number,
  currentProfile: string | undefined,
): string {
  const pageSize = 10;
  const start = Math.floor(selectedIndex / pageSize) * pageSize;
  let output = "MaybeCode — Select model\n\n";
  for (const [offset, model] of models.slice(start, start + pageSize).entries()) {
    const index = start + offset;
    const selected = index === selectedIndex ? ">" : " ";
    const current = model.name === currentProfile ? " [current]" : "";
    const defaultModel = model.isDefault ? " [default]" : "";
    output += `${selected} ${model.name}${current}${defaultModel}\n` +
      `    ${model.provider}/${model.model} · ${model.adapter}\n`;
  }
  return output + "\n↑↓ move · Enter select · D set default · Esc close\n";
}

function renderLineModelList(
  models: readonly MaybeCodeModelProfile[],
  currentProfile: string | undefined,
): string {
  const lines = models.map((model, index) => {
    const current = model.name === currentProfile ? " [current]" : "";
    const defaultModel = model.isDefault ? " [default]" : "";
    return `  ${index + 1}. ${model.name}${current}${defaultModel}\n` +
      `     ${model.provider}/${model.model} · ${model.adapter}`;
  });
  return `Models:\n${lines.join("\n")}\n`;
}
