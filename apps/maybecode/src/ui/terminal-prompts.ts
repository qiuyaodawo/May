import type { KeyStroke, Keymap } from "@sortedyuan/tui/keybindings";
import type { ApprovalDecision, ApprovalRequest } from "@sortedyuan/may/permissions";
import {
  Column,
  Editor,
  ScrollView,
  SelectList,
  Text,
  sanitizeTerminalText,
  type InteractiveComponent,
  type RenderResult,
  type RenderSize,
  type TuiTheme,
  type PointerEvent,
  type EditorOptions,
} from "@sortedyuan/tui";
import type { MaybeCodeModelProfile, MaybeCodeReasoningEffortState } from "../controller.js";
import { createMaybeCodeKeymap, type MaybeCodeKeymapOptions } from "../keymap.js";
import type { ModelDialogAction } from "./terminal-view.js";

export interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision | undefined) => void;
}

export class ModelPrompt implements InteractiveComponent {
  private readonly list: SelectList<MaybeCodeModelProfile>;
  private readonly keymap: Keymap;
  private readonly layout = new Column([], { gap: 1 });

  constructor(
    models: readonly MaybeCodeModelProfile[],
    currentProfile: string | undefined,
    theme: TuiTheme,
    private readonly complete: (action: ModelDialogAction | undefined) => void,
    keymapOptions: MaybeCodeKeymapOptions = {},
  ) {
    this.keymap = createMaybeCodeKeymap(keymapOptions);
    const currentIndex = models.findIndex((model) => model.name === currentProfile);
    this.list = new SelectList(
      models.map((model) => ({
        value: model,
        label: `${model.name === currentProfile ? "* " : ""}${model.name}` + `${model.isDefault ? " [default]" : ""}`,
        description: `${model.provider}/${model.model} · ${model.adapter}${model.searchStatus ? ` · ${model.searchStatus}` : ""}`,
      })),
      {
        onSelect: (item) => this.complete({ type: "switch", profile: item.value.name }),
        onCancel: () => this.complete(undefined),
        selectedIndex: Math.max(0, currentIndex),
        selectedStyle: theme.selected,
        descriptionStyle: theme.muted,
        markerStyle: theme.accent,
        emptyLabel: "No model profiles configured",
      },
    );
    this.list.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    this.layout.setItems([
      { flex: 1, minHeight: 1, component: this.list },
      {
        height: 1,
        component: new Text(
          `${promptShortcut(this.keymap, "list.accept", "select")} select · ${promptShortcut(this.keymap, "model.default.set", "modelPicker")} set default · ${promptShortcut(this.keymap, "list.cancel", "select")} close`,
        ),
      },
    ]);
    return this.layout.render(size);
  }

  handlePointer(event: PointerEvent): boolean {
    return this.layout.handlePointer(event);
  }

  handleKey(stroke: KeyStroke): boolean {
    const result = this.keymap.resolve(stroke, ["select", "modelPicker"]);
    if (result.type === "pending") return true;
    if (result.type === "action" && result.action === "model.default.set") {
      const selected = this.list.selectedItem?.value;
      if (selected === undefined) return false;
      this.complete({ type: "set-default", profile: selected.name });
      return true;
    }
    return result.type === "action" && result.action.startsWith("list.")
      ? this.list.performAction(result.action)
      : false;
  }
}

export class EffortPrompt implements InteractiveComponent {
  private readonly list: SelectList<string>;
  private readonly keymap: Keymap;
  private readonly layout = new Column([], { gap: 1 });

  constructor(
    state: MaybeCodeReasoningEffortState,
    theme: TuiTheme,
    private readonly complete: (effort: string | undefined) => void,
    keymapOptions: MaybeCodeKeymapOptions = {},
  ) {
    this.keymap = createMaybeCodeKeymap(keymapOptions);
    const efforts = ["default", ...state.efforts];
    const currentIndex = state.overridden ? efforts.indexOf(state.effectiveEffort ?? "") : 0;
    this.list = new SelectList(
      efforts.map((effort) => ({
        value: effort,
        label: `${effort === efforts[currentIndex] ? "* " : ""}${effort}`,
        description:
          effort === "default"
            ? `Clear override · default ${state.defaultEffort ?? "is provider-defined"}`
            : `Capability source: ${state.source}`,
      })),
      {
        onSelect: (item) => this.complete(item.value),
        onCancel: () => this.complete(undefined),
        selectedIndex: Math.max(0, currentIndex),
        selectedStyle: theme.selected,
        descriptionStyle: theme.muted,
        markerStyle: theme.accent,
      },
    );
    this.list.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    this.layout.setItems([
      { flex: 1, minHeight: 1, component: this.list },
      {
        height: 1,
        component: new Text(
          `${promptShortcut(this.keymap, "list.accept", "select")} select · ${promptShortcut(this.keymap, "list.cancel", "select")} close`,
        ),
      },
    ]);
    return this.layout.render(size);
  }

  handlePointer(event: PointerEvent): boolean {
    return this.layout.handlePointer(event);
  }

  handleKey(stroke: KeyStroke): boolean {
    const result = this.keymap.resolve(stroke, ["select"]);
    return result.type === "action" ? this.list.performAction(result.action) : result.type === "pending";
  }
}

export class ApprovalPrompt implements InteractiveComponent {
  private readonly choices: SelectList<ApprovalDecision>;
  private readonly keymap: Keymap;
  private readonly layout = new Column([], { gap: 1 });

  constructor(
    private readonly request: ApprovalRequest,
    private readonly theme: TuiTheme,
    private readonly decide: (decision: ApprovalDecision) => void,
    keymapOptions: MaybeCodeKeymapOptions = {},
  ) {
    this.keymap = createMaybeCodeKeymap(keymapOptions);
    this.choices = new SelectList(
      [
        { value: "allow", label: "Allow once", description: promptShortcut(this.keymap, "approval.allow", "approval") },
        ...(request.grantKey === undefined
          ? []
          : [
              {
                value: "allow-session" as const,
                label: "Allow matching calls for this session",
                description: promptShortcut(this.keymap, "approval.allowSession", "approval"),
              },
            ]),
        {
          value: "deny",
          label: "Deny",
          description: `${promptShortcut(this.keymap, "approval.deny", "approval")} / ${promptShortcut(this.keymap, "list.cancel", "select")}`,
        },
        ...(request.persistent
          ? [{ value: "allow-persistent" as const, label: "保存允许规则", description: request.persistent.description }]
          : []),
      ],
      {
        onSelect: (item) => this.decide(item.value),
        onCancel: () => this.decide("deny"),
        selectedStyle: this.theme.selected,
        descriptionStyle: this.theme.muted,
        markerStyle: this.theme.accent,
      },
    );
    this.choices.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    const input = truncate(sanitizeTerminalText(stringify(this.request.input)), 1_200);
    this.layout.setItems([
      {
        height: 1,
        component: new Text(`Tool: ${sanitizeTerminalText(this.request.tool.name)}`),
      },
      { flex: 1, minHeight: 1, component: new Text(input) },
      {
        height: (this.request.grantKey === undefined ? 2 : 3) + (this.request.persistent ? 2 : 0),
        component: this.choices,
      },
    ]);
    return this.layout.render(size);
  }

  handlePointer(event: PointerEvent): boolean {
    return this.layout.handlePointer(event);
  }

  handleKey(stroke: KeyStroke): boolean {
    const result = this.keymap.resolve(stroke, ["select", "approval"]);
    if (result.type === "pending") return true;
    if (result.type === "action" && result.action === "approval.allow") {
      this.decide("allow");
      return true;
    }
    if (result.type === "action" && result.action === "approval.allowSession" && this.request.grantKey !== undefined) {
      this.decide("allow-session");
      return true;
    }
    if (result.type === "action" && result.action === "approval.deny") {
      this.decide("deny");
      return true;
    }
    return result.type === "action" && result.action.startsWith("list.")
      ? this.choices.performAction(result.action)
      : false;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/** Ephemeral editor, deliberately without EditorHistory or TranscriptStore writes. */
export class McpInputPrompt implements InteractiveComponent {
  private readonly body: ScrollView;
  private readonly editor: Editor;
  private readonly layout = new Column([]);
  private readonly keymap: Keymap;
  private reviewPageSize = 1;
  constructor(
    prompt: string,
    private readonly complete: (value?: string) => void,
    editorOptions: Pick<EditorOptions, "clipboard" | "onInvalidate" | "onError" | "keybindings">,
    keymapOptions: MaybeCodeKeymapOptions = {},
  ) {
    this.keymap = createMaybeCodeKeymap(keymapOptions);
    this.body = new ScrollView(new Text(sanitizeTerminalText(prompt)));
    this.body.setFocused(true);
    this.editor = new Editor({ ...editorOptions, prompt: "> ", onSubmit: (value) => complete(value) });
    this.editor.setFocused(true);
  }
  render(size: RenderSize): RenderResult {
    this.reviewPageSize = Math.max(1, size.height - 5);
    this.layout.setItems([
      { flex: 1, minHeight: 1, component: this.body },
      { height: 4, component: this.editor },
      {
        height: 1,
        component: new Text(
          `${promptShortcut(this.keymap, "request.pageUp", "mcpInput")}/${promptShortcut(this.keymap, "request.pageDown", "mcpInput")} review request | Enter continue | ${promptShortcut(this.keymap, "request.cancel", "mcpInput")} cancel`,
        ),
      },
    ]);
    return this.layout.render(size);
  }
  handlePointer(event: PointerEvent): boolean {
    return this.layout.handlePointer(event);
  }
  dispose(): void {
    this.editor.dispose();
    this.body.dispose();
  }
  handleKey(stroke: KeyStroke): boolean {
    const result = this.keymap.resolve(stroke, ["mcpInput"]);
    if (result.type === "pending") return true;
    if (result.type === "action") {
      switch (result.action) {
        case "request.cancel":
          this.complete();
          return true;
        case "request.pageUp":
          this.body.scrollBy(-this.reviewPageSize);
          return true;
        case "request.pageDown":
          this.body.scrollBy(this.reviewPageSize);
          return true;
        case "request.scrollUp":
          this.body.scrollBy(-3);
          return true;
        case "request.scrollDown":
          this.body.scrollBy(3);
          return true;
      }
    }
    return this.editor.handleKey(stroke);
  }
}

export function promptShortcut(keymap: Keymap, action: string, context: string): string {
  return keymap.keysForAction(action, context).join(" / ");
}
