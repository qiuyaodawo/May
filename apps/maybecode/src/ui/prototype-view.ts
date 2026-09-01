import type { KeyStroke } from "@may/keybindings";
import type { ApprovalDecision, ApprovalRequest } from "@may/permissions";
import {
  Column,
  Dialog,
  Editor,
  EditorHistory,
  FocusManager,
  Panel,
  ScrollView,
  SelectList,
  Text,
  sanitizeTerminalText,
  styleText,
  type Component,
  type InteractiveComponent,
  type RenderResult,
  type RenderSize,
  type TuiTheme,
} from "@may/tui";
import { TranscriptStore } from "./transcript-store.js";
import { TranscriptView } from "./transcript-view.js";
import type { MaybeCodeSlashCommandSuggestion } from "../slash-commands.js";
import type { SessionSummary } from "../catalog.js";
import type {
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "../controller.js";
import { createMaybeCodeKeymap } from "../keymap.js";
import { MAYBECODE_DARK_THEME } from "./theme.js";
import type { ToolRendererRegistry } from "./tool-renderers.js";
import { MaybeCodeUiActionRegistry } from "./actions.js";

export interface MaybeCodePrototypeViewOptions {
  readonly store: TranscriptStore;
  readonly workspace: string;
  readonly model?: string;
  readonly theme?: TuiTheme;
  readonly toolRenderers?: ToolRendererRegistry;
  readonly uiActions?: MaybeCodeUiActionRegistry;
  readonly inputHistory?: EditorHistory;
  readonly recordInput?: (value: string) => boolean;
  readonly suggestions?: (
    input: string,
  ) => Promise<readonly MaybeCodeSlashCommandSuggestion[]>;
  readonly onSubmit: (
    value: string,
    accepted?: () => void,
  ) => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly onInvalidate?: () => void;
}

export type SessionDialogAction =
  | { readonly type: "resume"; readonly sessionId: string }
  | { readonly type: "rename"; readonly sessionId: string; readonly title: string }
  | { readonly type: "delete"; readonly sessionId: string };

export type ModelDialogAction =
  | { readonly type: "switch"; readonly profile: string }
  | { readonly type: "set-default"; readonly profile: string };

/** Retained MaybeCode view shared by the experimental terminal frontend. */
export class MaybeCodePrototypeView implements InteractiveComponent {
  private readonly focus = new FocusManager();
  private readonly keymap = createMaybeCodeKeymap();
  private readonly theme: TuiTheme;
  private readonly transcriptView: TranscriptView;
  private readonly transcript: ScrollView;
  private readonly uiActions: MaybeCodeUiActionRegistry;
  private readonly inputHistory: EditorHistory;
  private readonly editor: Editor;
  private readonly suggestionList: SelectList<MaybeCodeSlashCommandSuggestion>;
  private suggestions: readonly MaybeCodeSlashCommandSuggestion[] = [];
  private suggestionsVisible = false;
  private suggestionVersion = 0;
  private submissionInFlight = false;
  private status = "Ready";
  private model: string;
  private readonly unsubscribe: () => void;
  private readonly approvalQueue: PendingApproval[] = [];
  private dialog: Dialog | undefined;
  private dialogKind: "approval" | "session" | "model" | "effort" | undefined;
  private resolveSessionDialog: ((action: SessionDialogAction | undefined) => void) | undefined;
  private resolveModelDialog: ((action: ModelDialogAction | undefined) => void) | undefined;
  private resolveEffortDialog: ((effort: string | undefined) => void) | undefined;
  private readonly baseView: InteractiveComponent = {
    render: (size) => this.renderBase(size),
    handleKey: (stroke) => this.handleBaseKey(stroke),
  };

  constructor(private readonly options: MaybeCodePrototypeViewOptions) {
    this.theme = options.theme ?? MAYBECODE_DARK_THEME;
    this.model = options.model ?? "model: unknown";
    this.transcriptView = new TranscriptView(options.store, {
      theme: this.theme,
      ...(options.toolRenderers === undefined ? {} : { toolRenderers: options.toolRenderers }),
    });
    this.transcript = new ScrollView(this.transcriptView, {
      followEnd: true,
    });
    this.inputHistory = options.inputHistory ?? new EditorHistory();
    this.uiActions = options.uiActions ?? new MaybeCodeUiActionRegistry()
      .register({
        id: "tools.toggle",
        command: "/details",
        description: "Toggle all tool execution details",
        run: () => {
          this.preserveSelectedToolPosition();
          const visible = this.transcriptView.toggleToolDetails();
          return `Tool details ${visible ? "shown" : "hidden"}`;
        },
      })
      .register({
        id: "thinking.toggle",
        command: "/thinking",
        description: "Toggle reasoning block visibility",
        run: () => {
          this.preserveSelectedToolPosition();
          const visible = this.transcriptView.toggleReasoning();
          return `Thinking ${visible ? "shown" : "hidden"}`;
        },
      });
    this.editor = new Editor({
      history: this.inputHistory,
      placeholder: "Ask MaybeCode…",
      promptStyle: this.theme.accent,
      placeholderStyle: this.theme.dim,
      onSubmit: (value) => this.submit(value),
      onChange: (value) => this.refreshSuggestions(value),
    });
    this.suggestionList = new SelectList<MaybeCodeSlashCommandSuggestion>([], {
      selectedStyle: this.theme.selected,
      descriptionStyle: this.theme.muted,
      markerStyle: this.theme.accent,
      emptyLabel: "No matching commands",
    });
    this.suggestionList.setFocused(true);
    this.focus.register("transcript", this.transcript);
    this.focus.register("editor", this.editor);
    this.focus.focus("editor");
    this.unsubscribe = options.store.subscribe(() => options.onInvalidate?.());
  }

  render(size: RenderSize): RenderResult {
    return this.dialog?.render(size) ?? this.renderBase(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (stroke.ctrl && stroke.key === "c") {
      this.options.onCancel?.();
      return this.options.onCancel !== undefined;
    }
    return this.dialog?.handleKey(stroke) ?? this.handleBaseKey(stroke);
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    return new Promise((resolve) => {
      this.approvalQueue.push({ request, resolve });
      if (this.approvalQueue.length === 1) this.openCurrentApproval();
    });
  }

  dismissApproval(requestId: string): boolean {
    const index = this.approvalQueue.findIndex((item) =>
      item.request.id === requestId
    );
    if (index < 0) return false;
    const [approval] = this.approvalQueue.splice(index, 1);
    approval?.resolve(undefined);
    if (index === 0 && this.dialogKind === "approval") {
      this.dialog = undefined;
      this.dialogKind = undefined;
      this.openCurrentApproval();
    }
    this.options.onInvalidate?.();
    return true;
  }

  requestSessionAction(
    sessions: readonly SessionSummary[],
    currentSessionId: string,
  ): Promise<SessionDialogAction | undefined> {
    if (this.dialog !== undefined || this.resolveSessionDialog !== undefined) {
      return Promise.reject(new Error("Another dialog is already open"));
    }
    return new Promise((resolve) => {
      this.resolveSessionDialog = resolve;
      const prompt = new SessionPrompt(sessions, currentSessionId, this.theme, (action) => {
        this.dialog = undefined;
        this.dialogKind = undefined;
        const complete = this.resolveSessionDialog;
        this.resolveSessionDialog = undefined;
        complete?.(action);
        this.openCurrentApproval();
        this.options.onInvalidate?.();
      });
      this.dialog = new Dialog(this.baseView, prompt, {
        open: true,
        title: "Sessions",
        width: 92,
        height: 18,
        dismissOnEscape: false,
        borderStyle: this.theme.borderAccent,
        titleStyle: this.theme.accent,
      });
      this.dialogKind = "session";
      this.options.onInvalidate?.();
    });
  }

  requestModelAction(
    models: readonly MaybeCodeModelProfile[],
    currentProfile: string | undefined,
  ): Promise<ModelDialogAction | undefined> {
    if (this.dialog !== undefined || this.resolveModelDialog !== undefined) {
      return Promise.reject(new Error("Another dialog is already open"));
    }
    return new Promise((resolve) => {
      this.resolveModelDialog = resolve;
      const prompt = new ModelPrompt(
        models,
        currentProfile,
        this.theme,
        (action) => {
          this.dialog = undefined;
          this.dialogKind = undefined;
          const complete = this.resolveModelDialog;
          this.resolveModelDialog = undefined;
          complete?.(action);
          this.openCurrentApproval();
          this.options.onInvalidate?.();
        },
      );
      this.dialog = new Dialog(this.baseView, prompt, {
        open: true,
        title: "Models",
        width: 82,
        height: 16,
        dismissOnEscape: false,
        borderStyle: this.theme.borderAccent,
        titleStyle: this.theme.accent,
      });
      this.dialogKind = "model";
      this.options.onInvalidate?.();
    });
  }

  requestReasoningEffortSelection(
    state: MaybeCodeReasoningEffortState,
  ): Promise<string | undefined> {
    if (
      state.status !== "known" ||
      this.dialog !== undefined ||
      this.resolveEffortDialog !== undefined
    ) {
      return state.status === "known"
        ? Promise.reject(new Error("Another dialog is already open"))
        : Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.resolveEffortDialog = resolve;
      const prompt = new EffortPrompt(state, this.theme, (effort) => {
        this.dialog = undefined;
        this.dialogKind = undefined;
        const complete = this.resolveEffortDialog;
        this.resolveEffortDialog = undefined;
        complete?.(effort);
        this.openCurrentApproval();
        this.options.onInvalidate?.();
      });
      this.dialog = new Dialog(this.baseView, prompt, {
        open: true,
        title: "Reasoning effort",
        width: 62,
        height: Math.min(16, state.efforts.length + 7),
        dismissOnEscape: false,
        borderStyle: this.theme.borderAccent,
        titleStyle: this.theme.accent,
      });
      this.dialogKind = "effort";
      this.options.onInvalidate?.();
    });
  }

  setStatus(status: string): void {
    this.status = sanitizeTerminalText(status);
    this.options.onInvalidate?.();
  }

  setModel(model: string): void {
    this.model = sanitizeTerminalText(model);
    this.options.onInvalidate?.();
  }

  get displayCommands(): readonly {
    readonly command: string;
    readonly description: string;
  }[] {
    return this.uiActions.listCommands();
  }

  dispose(): void {
    this.unsubscribe();
    this.focus.clear();
    this.dialog = undefined;
    this.dialogKind = undefined;
    this.resolveSessionDialog?.(undefined);
    this.resolveSessionDialog = undefined;
    this.resolveModelDialog?.(undefined);
    this.resolveModelDialog = undefined;
    this.resolveEffortDialog?.(undefined);
    this.resolveEffortDialog = undefined;
    this.suggestionVersion += 1;
    for (const approval of this.approvalQueue.splice(0)) {
      approval.resolve(undefined);
    }
  }

  private renderBase(size: RenderSize): RenderResult {
    const suggestionHeight = this.suggestionsVisible
      ? Math.min(7, this.suggestions.length + 2)
      : 0;
    return new Column([
      {
        height: 3,
        component: new HeaderView(
          this.options.workspace,
          this.model,
          this.theme,
        ),
      },
      { flex: 1, minHeight: 1, component: this.transcript },
      ...(suggestionHeight === 0
        ? []
        : [{
            height: suggestionHeight,
            component: new Panel(this.suggestionList, {
              title: " Commands ",
              borderStyle: this.theme.border,
              titleStyle: this.theme.accent,
            }),
          }]),
      {
        height: 4,
        component: new Panel(this.editor, {
          borderStyle: this.focus.focusedId === "editor"
            ? this.theme.borderAccent
            : this.theme.border,
        }),
      },
      {
        height: 1,
        component: new FooterView(
          this.status,
          this.focus.focusedId,
          this.transcriptView.toolDetailsMode,
          this.transcriptView.showReasoning,
          this.theme,
        ),
      },
    ]).render(size);
  }

  private handleBaseKey(stroke: KeyStroke): boolean {
    const shortcut = this.keymap.resolve(stroke, ["global"]);
    if (shortcut.type === "pending") {
      this.status = `Shortcut: ${shortcut.completions.join(" / ")}`;
      this.options.onInvalidate?.();
      return true;
    }
    if (shortcut.type === "action") {
      if (shortcut.action === "app.tools.toggle") {
        this.executeUiAction("tools.toggle");
        return true;
      }
      if (shortcut.action === "app.thinking.toggle") {
        this.executeUiAction("thinking.toggle");
        return true;
      }
    }
    if (this.focus.focusedId === "editor" && this.editor.value.startsWith("/")) {
      if (stroke.key === "escape" && this.suggestionsVisible) {
        this.hideSuggestions();
        return true;
      }
      if (this.suggestionsVisible && isSuggestionNavigation(stroke.key)) {
        return this.suggestionList.handleKey(stroke);
      }
      if (stroke.key === "tab" && !stroke.shift) {
        this.completeSuggestion(false);
        return true;
      }
      if (stroke.key === "enter" && this.suggestionsVisible) {
        this.completeSuggestion(true);
        return true;
      }
    }
    if (stroke.key === "tab") {
      const changed = stroke.shift ? this.focus.focusPrevious() : this.focus.focusNext();
      if (this.focus.focusedId === "transcript") this.ensureSelectedToolVisible();
      return changed;
    }
    const transcriptInteraction = stroke.key === "j" || stroke.key === "k" ||
      stroke.key === "enter" || stroke.key === "space" || stroke.text === " ";
    const togglesSelectedTool = this.focus.focusedId === "transcript" &&
      (stroke.key === "enter" || stroke.key === "space" || stroke.text === " ");
    if (togglesSelectedTool) this.preserveSelectedToolPosition();
    const handled = this.focus.dispatch(stroke);
    if (handled && this.focus.focusedId === "transcript" && transcriptInteraction) {
      this.ensureSelectedToolVisible();
      if (stroke.key === "enter" || stroke.key === "space" || stroke.text === " ") {
        this.status = "Selected tool details toggled";
      }
    }
    return handled;
  }

  private submit(value: string, completeCommand = true): void {
    if (value.trim() === "") return;
    if (this.submissionInFlight) {
      this.setStatus("An operation is already active");
      return;
    }
    this.submissionInFlight = true;
    this.inputHistory.record(value);
    this.editor.setValue("");
    this.hideSuggestions();
    this.setStatus("Running");
    void this.resolveSubmission(value, completeCommand)
      .then(
        (status) => this.setStatus(status ?? "Ready"),
        (error: unknown) => this.setStatus(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => this.submissionInFlight = false);
  }

  private async resolveSubmission(
    value: string,
    completeCommand: boolean,
  ): Promise<string | undefined> {
    let submission = value;
    if (completeCommand && value.startsWith("/")) {
      const suggestions = await this.suggestionsFor(value);
      submission = suggestions[0]?.value ?? value;
    }
    const uiResult = this.uiActions.executeCommand(submission);
    if (uiResult.matched) return uiResult.status;
    this.transcript.scrollToEnd();
    let recorded = false;
    const recordAcceptedInput = (): void => {
      if (recorded) return;
      recorded = true;
      if (this.options.recordInput?.(submission) ?? true) {
        this.options.store.appendUser(submission);
      }
    };
    await this.options.onSubmit(submission, recordAcceptedInput);
    recordAcceptedInput();
    return undefined;
  }

  private refreshSuggestions(value: string): void {
    const version = ++this.suggestionVersion;
    if (!value.startsWith("/")) {
      this.hideSuggestions();
      return;
    }
    void this.suggestionsFor(value).then(
      (suggestions) => {
        if (version !== this.suggestionVersion || value !== this.editor.value) return;
        this.suggestions = suggestions;
        this.suggestionList.setItems(suggestions.map((suggestion) => ({
          value: suggestion,
          label: suggestion.label,
          ...(suggestion.description === undefined
            ? {}
            : { description: suggestion.description }),
        })));
        this.suggestionsVisible = suggestions.length > 0;
        this.options.onInvalidate?.();
      },
      () => {
        if (version === this.suggestionVersion) this.hideSuggestions();
      },
    );
  }

  private completeSuggestion(execute: boolean): void {
    const selected = this.suggestionList.selectedItem?.value ?? this.suggestions[0];
    if (selected === undefined) return;
    if (execute) {
      this.hideSuggestions();
      this.editor.setValue("");
      this.submit(selected.value, false);
      return;
    }
    const completion = commonPrefix(
      this.editor.value,
      this.suggestions.map((suggestion) => suggestion.value),
    );
    if (completion !== undefined) this.editor.setValue(completion);
  }

  private hideSuggestions(): void {
    this.suggestions = [];
    this.suggestionsVisible = false;
    this.suggestionList.setItems([]);
    this.options.onInvalidate?.();
  }

  private openCurrentApproval(): void {
    if (this.dialog !== undefined) return;
    const pending = this.approvalQueue[0];
    if (pending === undefined) {
      this.dialog = undefined;
      return;
    }
    const prompt = new ApprovalPrompt(pending.request, this.theme, (decision) => {
      const current = this.approvalQueue.shift();
      this.dialog = undefined;
      this.dialogKind = undefined;
      current?.resolve(decision);
      this.openCurrentApproval();
      this.options.onInvalidate?.();
    });
    this.dialog = new Dialog(this.baseView, prompt, {
      open: true,
      title: `Approval: ${sanitizeTerminalText(pending.request.tool.name)}`,
      width: 72,
      height: pending.request.grantKey === undefined ? 10 : 11,
      dismissOnEscape: false,
      borderStyle: this.theme.warning,
      titleStyle: this.theme.warning,
    });
    this.dialogKind = "approval";
    this.options.onInvalidate?.();
  }

  private ensureSelectedToolVisible(): void {
    const anchor = this.transcriptView.selectedToolAnchor;
    if (anchor !== undefined) this.transcript.ensureVisible(anchor, 2);
  }

  private preserveSelectedToolPosition(): void {
    const anchor = this.transcriptView.selectedToolAnchor;
    if (anchor === undefined) {
      this.transcript.detachFromEnd();
      return;
    }
    this.transcript.preserveAnchor(
      anchor,
      () => this.transcriptView.selectedToolAnchor,
    );
  }

  private executeUiAction(id: string): void {
    const status = this.uiActions.execute(id);
    if (status !== undefined) this.setStatus(status);
  }

  private async suggestionsFor(
    value: string,
  ): Promise<readonly MaybeCodeSlashCommandSuggestion[]> {
    const local = this.uiActions.suggestions(value);
    const controller = await (this.options.suggestions?.(value) ?? Promise.resolve([]));
    const seen = new Set<string>();
    return [...local, ...controller].filter((suggestion) => {
      if (seen.has(suggestion.value)) return false;
      seen.add(suggestion.value);
      return true;
    });
  }
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision | undefined) => void;
}

class ModelPrompt implements InteractiveComponent {
  private readonly list: SelectList<MaybeCodeModelProfile>;

  constructor(
    models: readonly MaybeCodeModelProfile[],
    currentProfile: string | undefined,
    theme: TuiTheme,
    private readonly complete: (action: ModelDialogAction | undefined) => void,
  ) {
    const currentIndex = models.findIndex((model) =>
      model.name === currentProfile
    );
    this.list = new SelectList(models.map((model) => ({
      value: model,
      label: `${model.name === currentProfile ? "* " : ""}${model.name}` +
        `${model.isDefault ? " [default]" : ""}`,
      description: `${model.provider}/${model.model} · ${model.adapter}`,
    })), {
      selectedIndex: Math.max(0, currentIndex),
      selectedStyle: theme.selected,
      descriptionStyle: theme.muted,
      markerStyle: theme.accent,
      emptyLabel: "No model profiles configured",
    });
    this.list.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    return new Column([
      { flex: 1, minHeight: 1, component: this.list },
      {
        height: 1,
        component: new Text("Enter select · D set default · Esc close"),
      },
    ], { gap: 1 }).render(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (stroke.key === "escape") {
      this.complete(undefined);
      return true;
    }
    if (stroke.key === "enter") {
      const selected = this.list.selectedItem?.value;
      if (selected === undefined) return false;
      this.complete({ type: "switch", profile: selected.name });
      return true;
    }
    if (
      stroke.key.toLowerCase() === "d" &&
      !stroke.ctrl && !stroke.alt && !stroke.meta
    ) {
      const selected = this.list.selectedItem?.value;
      if (selected === undefined) return false;
      this.complete({ type: "set-default", profile: selected.name });
      return true;
    }
    return this.list.handleKey(stroke);
  }
}

class EffortPrompt implements InteractiveComponent {
  private readonly list: SelectList<string>;

  constructor(
    state: MaybeCodeReasoningEffortState,
    theme: TuiTheme,
    private readonly complete: (effort: string | undefined) => void,
  ) {
    const efforts = ["default", ...state.efforts];
    const currentIndex = state.overridden
      ? efforts.indexOf(state.effectiveEffort ?? "")
      : 0;
    this.list = new SelectList(efforts.map((effort) => ({
      value: effort,
      label: `${effort === efforts[currentIndex] ? "* " : ""}${effort}`,
      description: effort === "default"
        ? `Clear override · default ${state.defaultEffort ?? "is provider-defined"}`
        : `Capability source: ${state.source}`,
    })), {
      selectedIndex: Math.max(0, currentIndex),
      selectedStyle: theme.selected,
      descriptionStyle: theme.muted,
      markerStyle: theme.accent,
    });
    this.list.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    return new Column([
      { flex: 1, minHeight: 1, component: this.list },
      { height: 1, component: new Text("Enter select · Esc close") },
    ], { gap: 1 }).render(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (stroke.key === "escape") {
      this.complete(undefined);
      return true;
    }
    if (stroke.key === "enter") {
      const selected = this.list.selectedItem?.value;
      if (selected === undefined) return false;
      this.complete(selected);
      return true;
    }
    return this.list.handleKey(stroke);
  }
}

class ApprovalPrompt implements InteractiveComponent {
  private readonly choices: SelectList<ApprovalDecision>;

  constructor(
    private readonly request: ApprovalRequest,
    private readonly theme: TuiTheme,
    private readonly decide: (decision: ApprovalDecision) => void,
  ) {
    this.choices = new SelectList([
      { value: "allow", label: "Allow once", description: "a" },
      ...(request.grantKey === undefined
        ? []
        : [{
            value: "allow-session" as const,
            label: "Allow matching calls for this session",
            description: "s",
          }]),
      { value: "deny", label: "Deny", description: "d / Esc" },
    ], {
      onSelect: (item) => this.decide(item.value),
      selectedStyle: this.theme.selected,
      descriptionStyle: this.theme.muted,
      markerStyle: this.theme.accent,
    });
    this.choices.setFocused(true);
  }

  render(size: RenderSize): RenderResult {
    const input = truncate(sanitizeTerminalText(stringify(this.request.input)), 1_200);
    return new Column([
      {
        height: 1,
        component: new Text(
          `Tool: ${sanitizeTerminalText(this.request.tool.name)}`,
        ),
      },
      { flex: 1, minHeight: 1, component: new Text(input) },
      {
        height: this.request.grantKey === undefined ? 2 : 3,
        component: this.choices,
      },
    ], { gap: 1 }).render(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (stroke.key === "a") {
      this.decide("allow");
      return true;
    }
    if (stroke.key === "s" && this.request.grantKey !== undefined) {
      this.decide("allow-session");
      return true;
    }
    if (stroke.key === "d" || stroke.key === "escape") {
      this.decide("deny");
      return true;
    }
    return this.choices.handleKey(stroke);
  }
}

type SessionMode = "browse" | "search" | "rename" | "delete";

class SessionPrompt implements InteractiveComponent {
  private mode: SessionMode = "browse";
  private query = "";
  private status = "";
  private readonly list: SelectList<SessionSummary>;
  private readonly input: Editor;

  constructor(
    private readonly sessions: readonly SessionSummary[],
    private readonly currentSessionId: string,
    private readonly theme: TuiTheme,
    private readonly complete: (action: SessionDialogAction | undefined) => void,
  ) {
    this.list = new SelectList<SessionSummary>([], {
      selectedStyle: this.theme.selected,
      descriptionStyle: this.theme.muted,
      markerStyle: this.theme.accent,
      emptyLabel: "No matching sessions",
    });
    this.list.setFocused(true);
    this.input = new Editor({
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
    return new Column([
      { height: 1, component: new Text(this.heading()) },
      { flex: 1, minHeight: 1, component: this.list },
      { height: 2, component: this.footer() },
    ], { gap: 1 }).render(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    if (this.mode === "delete") return this.handleDelete(stroke);
    if (this.mode === "rename") {
      if (stroke.key === "escape") return this.setMode("browse");
      return this.input.handleKey(stroke);
    }
    if (stroke.key === "escape") {
      if (this.mode === "search") return this.setMode("browse");
      this.complete(undefined);
      return true;
    }
    if (isSuggestionNavigation(stroke.key)) return this.list.handleKey(stroke);
    if (stroke.key === "enter") return this.resumeSelected();
    if (this.mode === "search") return this.input.handleKey(stroke);
    if (stroke.key === "/") {
      this.mode = "search";
      this.status = "Type to filter by id, title, or preview";
      this.input.setValue("");
      this.input.setFocused(true);
      return true;
    }
    if (stroke.key === "r") return this.beginRename();
    if (stroke.key === "d") return this.beginDelete();
    return false;
  }

  private footer(): InteractiveComponent {
    if (this.mode === "search" || this.mode === "rename") return this.input;
    return {
      render: (size) => new Text(
        this.mode === "delete"
          ? `${this.status}\n[y] delete / [n] cancel`
          : `${this.status}\nEnter resume · / search · r rename · d delete · Esc close`,
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
    const filtered = query === ""
      ? this.sessions
      : this.sessions.filter((session) =>
        [session.id, session.title, session.preview]
          .filter((value): value is string => value !== undefined)
          .some((value) => value.toLowerCase().includes(query))
      );
    this.list.setItems(filtered.map((session) => ({
      value: session,
      label: `${session.id === this.currentSessionId ? "* " : ""}${session.title ?? session.id}`,
      description: session.preview ?? (
        session.turnCount === undefined ? "No recorded turns" : `${session.turnCount} turns`
      ),
    })));
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
    this.mode = "rename";
    this.status = "Enter a new title";
    this.input.setValue(session.title ?? "");
    this.input.setFocused(true);
    return true;
  }

  private beginDelete(): boolean {
    const session = this.list.selectedItem?.value;
    if (session === undefined) return false;
    if (session.id === this.currentSessionId) {
      this.status = "The active session cannot be deleted";
      return true;
    }
    this.mode = "delete";
    this.status = `Delete ${sanitizeTerminalText(session.title ?? session.id)}?`;
    return true;
  }

  private handleDelete(stroke: KeyStroke): boolean {
    if (stroke.key === "n" || stroke.key === "escape") return this.setMode("browse");
    if (stroke.key !== "y") return false;
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
    this.input.setFocused(false);
    if (resetSearch) {
      this.query = "";
      this.refreshList();
    }
    return true;
  }
}

class HeaderView implements Component {
  constructor(
    private readonly workspace: string,
    private readonly model: string,
    private readonly theme: TuiTheme,
  ) {}

  render(size: RenderSize): RenderResult {
    const title = `${styleText("◆", this.theme.accent)} ` +
      `${styleText("MaybeCode", this.theme.accent)}  ` +
      styleText(sanitizeTerminalText(this.model), this.theme.muted);
    const workspace = `${styleText("workspace", this.theme.dim)}  ` +
      styleText(sanitizeTerminalText(this.workspace), this.theme.muted);
    const divider = styleText("─".repeat(size.width), this.theme.border);
    return new Text(`${title}\n${workspace}\n${divider}`, { wrap: false }).render(size);
  }
}

class FooterView implements Component {
  constructor(
    private readonly status: string,
    private readonly focus: string | undefined,
    private readonly details: "all" | "off" | "custom",
    private readonly reasoning: boolean,
    private readonly theme: TuiTheme,
  ) {}

  render(size: RenderSize): RenderResult {
    const statusStyle = /^error/iu.test(this.status)
      ? this.theme.error
      : /running|cancell/iu.test(this.status)
      ? this.theme.warning
      : this.theme.success;
    const value = `${styleText("●", statusStyle)} ${styleText(this.status, statusStyle)}  ` +
      `${styleText(this.focus ?? "none", this.theme.muted)}  ` +
      (this.focus === "transcript"
        ? `${styleText("J/K", this.theme.dim)} tools  ` +
          `${styleText("Enter", this.theme.dim)} toggle  ` +
          `${styleText("↑/↓", this.theme.dim)} scroll  ` +
          `${styleText("Tab", this.theme.dim)} editor`
        : `${styleText("Ctrl+X D", this.theme.dim)} details:${this.details}  ` +
          `${styleText("Ctrl+X T", this.theme.dim)} thinking:${this.reasoning ? "on" : "off"}  ` +
          `${styleText("Ctrl+C", this.theme.dim)} cancel`);
    return new Text(value, { wrap: false }).render(size);
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

function isSuggestionNavigation(key: string): boolean {
  return key === "up" || key === "down" || key === "pageup" ||
    key === "pagedown" || key === "home" || key === "end";
}

function commonPrefix(input: string, values: readonly string[]): string | undefined {
  const candidates = values.filter((value) => value.startsWith(input));
  const first = candidates[0];
  if (first === undefined) return undefined;
  let length = first.length;
  for (const value of candidates.slice(1)) {
    length = Math.min(length, value.length);
    let index = input.length;
    while (index < length && value[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}
