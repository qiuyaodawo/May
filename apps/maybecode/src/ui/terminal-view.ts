import type { KeyStroke, Keymap } from "@sortedyuan/tui/keybindings";
import { omitUndefined } from "@sortedyuan/may/core";
import type { ApprovalDecision, ApprovalRequest } from "@sortedyuan/may/permissions";
import {
  Column,
  Dialog,
  Editor,
  EditorHistory,
  FocusManager,
  Panel,
  ScrollView,
  SelectList,
  sanitizeTerminalText,
  type Component,
  type InteractiveComponent,
  type RenderResult,
  type RenderSize,
  type TuiTheme,
  type TerminalImages,
  type PointerEvent,
  type Clipboard,
  type EditorOptions,
  SessionForkPicker,
  WorkspaceDiffViewer,
  workspaceGitLabel,
  type SessionForkSelection,
} from "@sortedyuan/tui";
import type { UiForkPoint, UiWorkspaceDiff, UiWorkspaceGit } from "@sortedyuan/ui-client";
import { TranscriptStore, TranscriptView } from "@sortedyuan/tui/transcript";
import type { ToolRendererRegistry } from "@sortedyuan/tui/tool-renderers";
import type { MaybeCodeSlashCommandSuggestion } from "../slash-commands.js";
import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import type { MaybeCodeModelProfile, MaybeCodeReasoningEffortState } from "../controller.js";
import { createMaybeCodeKeymap, MAYBECODE_EDITOR_KEYBINDINGS, type MaybeCodeKeymapOptions } from "../keymap.js";
import { MAYBECODE_DARK_THEME } from "./theme.js";
import { MaybeCodeUiActionRegistry } from "./actions.js";
import { SessionPrompt } from "./session-prompt.js";
import { ApprovalPrompt, EffortPrompt, McpInputPrompt, ModelPrompt, type PendingApproval } from "./terminal-prompts.js";
import { FooterView, HeaderView } from "./terminal-chrome.js";

export interface MaybeCodeTerminalViewOptions {
  readonly isRunning?: () => boolean;
  readonly permissionMode?: () => import("../policy.js").MaybeCodePermissionMode;
  readonly clipboard?: Clipboard;
  readonly keymap?: MaybeCodeKeymapOptions;
  readonly images?: TerminalImages;
  readonly store: TranscriptStore;
  readonly workspace: string;
  readonly model?: string;
  readonly theme?: TuiTheme;
  readonly toolRenderers?: ToolRendererRegistry;
  readonly uiActions?: MaybeCodeUiActionRegistry;
  readonly inputHistory?: EditorHistory;
  readonly recordInput?: (value: string) => boolean;
  readonly suggestions?: (input: string) => Promise<readonly MaybeCodeSlashCommandSuggestion[]>;
  readonly onSubmit: (value: string, accepted?: () => void) => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly onInvalidate?: () => void;
}

export type SessionDialogAction =
  | { readonly type: "resume"; readonly sessionId: string }
  | { readonly type: "rename"; readonly sessionId: string; readonly title: string }
  | { readonly type: "delete"; readonly sessionId: string };

export type ModelDialogAction =
  { readonly type: "switch"; readonly profile: string } | { readonly type: "set-default"; readonly profile: string };

/** Retained MaybeCode view used by the default terminal frontend. */
export class MaybeCodeTerminalView implements InteractiveComponent {
  private readonly focus = new FocusManager();
  private readonly keymap: Keymap;
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
  private submissionTail: Promise<void> | undefined;
  private submissionEpoch = 0;
  private status = "Ready";
  private statusBeforeShortcut: string | undefined;
  private model: string;
  private workspace: string;
  private gitLabel = "";
  private readonly unsubscribe: () => void;
  private readonly approvalQueue: PendingApproval[] = [];
  private dialog: Dialog | undefined;
  private lastDialog: Dialog | undefined;
  private disposed = false;
  private pendingClipboard: Promise<void> = Promise.resolve();
  private readonly layout = new Column([]);
  private editorSize: RenderSize = { width: 1, height: 1 };
  private readonly editorRegion: Component = {
    render: (size) => {
      this.editorSize = size;
      return new Panel(this.editor, {
        borderStyle: this.focus.focusedId === "editor" ? this.theme.borderAccent : this.theme.border,
      }).render(size);
    },
    handlePointer: (event) => {
      if (event.type === "down") {
        if (event.button !== 0) return false;
        if (event.x < 1 || event.x >= this.editorSize.width - 1 || event.y < 1 || event.y >= this.editorSize.height - 1)
          return false;
        this.resetInputContext();
        this.focus.focus("editor");
        this.transcriptView.clearSelection();
      }
      return this.editor.handlePointer({ ...event, x: event.x - 1, y: event.y - 1 });
    },
  };
  private readonly transcriptRegion: Component = {
    render: (size) => this.transcript.render(size),
    handlePointer: (event) => {
      if (event.type === "down") {
        if (event.button !== 0) return false;
        this.resetInputContext();
        this.editor.clearSelection();
      }
      return this.transcript.handlePointer(event);
    },
  };
  private dialogKind: "approval" | "session" | "model" | "effort" | "mcp" | "fork" | "changes" | undefined;
  private resolveVersionDialog: ((selection?: SessionForkSelection) => void) | undefined;
  private readonly mcpQuestions: Array<{ prompt: string; finish(value?: string): void }> = [];
  private resolveSessionDialog: ((action: SessionDialogAction | undefined) => void) | undefined;
  private resolveModelDialog: ((action: ModelDialogAction | undefined) => void) | undefined;
  private resolveEffortDialog: ((effort: string | undefined) => void) | undefined;
  private readonly baseView: InteractiveComponent = {
    render: (size) => this.renderBase(size),
    handleKey: (stroke) => this.handleBaseKey(stroke),
    handlePointer: (event) => this.layout.handlePointer(event),
  };

  constructor(private readonly options: MaybeCodeTerminalViewOptions) {
    this.keymap = createMaybeCodeKeymap(options.keymap);
    this.theme = options.theme ?? MAYBECODE_DARK_THEME;
    this.model = options.model ?? "model: unknown";
    this.workspace = options.workspace;
    this.transcriptView = new TranscriptView(options.store, {
      ...(options.images ? { images: options.images } : {}),
      theme: this.theme,
      assistantLabel: "MaybeCode",
      selectedToolDetailsHint: "Enter details",
      toolDetailsHint: `${this.shortcutHint("app.tools.toggle")} all`,
      ...omitUndefined({ toolRenderers: options.toolRenderers }),
    });
    this.transcript = new ScrollView(this.transcriptView, {
      followEnd: true,
      onInvalidate: () => options.onInvalidate?.(),
    });
    this.inputHistory = options.inputHistory ?? new EditorHistory();
    this.uiActions =
      options.uiActions ??
      new MaybeCodeUiActionRegistry()
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
      ...this.editorOptions(),
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
    this.synchronizeDialog();
    return this.dialog?.render(size) ?? this.renderBase(size);
  }

  handleKey(stroke: KeyStroke): boolean {
    this.synchronizeDialog();
    if (this.dialog !== undefined) {
      const handled = this.dialog.handleKey(stroke);
      if (handled) return true;
      const shortcut = this.keymap.resolve(stroke, ["dialog"]);
      if (shortcut.type === "action" && shortcut.action === "app.interrupt") {
        this.submissionEpoch++;
        this.options.onCancel?.();
        return true;
      }
      return false;
    }
    return this.handleBaseKey(stroke);
  }

  handlePointer(event: PointerEvent): boolean {
    this.synchronizeDialog();
    return this.dialog?.handlePointer(event) ?? this.layout.handlePointer(event);
  }

  async waitForPendingClipboard(): Promise<void> {
    await this.pendingClipboard;
    await this.editor.waitForPendingClipboard();
  }

  private editorOptions(): Pick<EditorOptions, "clipboard" | "onInvalidate" | "onError" | "keybindings"> {
    return {
      keybindings: MAYBECODE_EDITOR_KEYBINDINGS,
      ...omitUndefined({ clipboard: this.options.clipboard }),
      onInvalidate: () => this.options.onInvalidate?.(),
      onError: (error) => this.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`),
    };
  }

  private shortcutHint(action: string): string {
    return (
      this.keymap
        .keysForAction(action)[0]
        ?.split(" ")
        .map((key) =>
          key
            .split("+")
            .map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
            .join("+"),
        )
        .join(" ") ?? ""
    );
  }

  private resetInputContext(): void {
    this.keymap.reset();
    this.editor.resetKeybindings();
    this.clearShortcutHint();
  }

  private clearShortcutHint(): void {
    if (this.statusBeforeShortcut !== undefined && this.status.startsWith("Shortcut: ")) {
      this.status = this.statusBeforeShortcut;
      this.options.onInvalidate?.();
    }
    this.statusBeforeShortcut = undefined;
  }

  private synchronizeDialog(): void {
    if (this.lastDialog === this.dialog) return;
    this.lastDialog?.dispose();
    this.lastDialog = this.dialog;
    this.resetInputContext();
    this.transcript.clearPointerSelection();
    this.editor.setFocused(this.dialog === undefined && this.focus.focusedId === "editor");
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    return new Promise((resolve) => {
      this.approvalQueue.push({ request, resolve });
      if (this.approvalQueue.length === 1) this.openCurrentApproval();
    });
  }

  requestMcpInput(prompt: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const abort = () => pending.finish();
      const pending = {
        prompt,
        finish: (value?: string) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          const index = this.mcpQuestions.indexOf(pending);
          if (index >= 0) this.mcpQuestions.splice(index, 1);
          if (index === 0 && this.dialogKind === "mcp") {
            this.dialog = undefined;
            this.dialogKind = undefined;
            this.openCurrentApproval();
          }
          resolve(value);
          this.options.onInvalidate?.();
        },
      };
      this.mcpQuestions.push(pending);
      signal.addEventListener("abort", abort, { once: true });
      this.openCurrentApproval();
    });
  }

  dismissApproval(requestId: string): boolean {
    const index = this.approvalQueue.findIndex((item) => item.request.id === requestId);
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
      const prompt = new SessionPrompt(
        sessions,
        currentSessionId,
        this.theme,
        (action) => {
          this.dialog = undefined;
          this.dialogKind = undefined;
          const complete = this.resolveSessionDialog;
          this.resolveSessionDialog = undefined;
          complete?.(action);
          this.openCurrentApproval();
          this.options.onInvalidate?.();
        },
        this.editorOptions(),
        this.options.keymap,
      );
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
      this.synchronizeDialog();
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
        this.options.keymap,
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
      this.synchronizeDialog();
      this.options.onInvalidate?.();
    });
  }

  requestReasoningEffortSelection(state: MaybeCodeReasoningEffortState): Promise<string | undefined> {
    if (state.status !== "known" || this.dialog !== undefined || this.resolveEffortDialog !== undefined) {
      return state.status === "known"
        ? Promise.reject(new Error("Another dialog is already open"))
        : Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.resolveEffortDialog = resolve;
      const prompt = new EffortPrompt(
        state,
        this.theme,
        (effort) => {
          this.dialog = undefined;
          this.dialogKind = undefined;
          const complete = this.resolveEffortDialog;
          this.resolveEffortDialog = undefined;
          complete?.(effort);
          this.openCurrentApproval();
          this.options.onInvalidate?.();
        },
        this.options.keymap,
      );
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
      this.synchronizeDialog();
      this.options.onInvalidate?.();
    });
  }

  setStatus(status: string): void {
    if (this.disposed) return;
    this.status = sanitizeTerminalText(status);
    this.options.onInvalidate?.();
  }

  setWorkspaceGit(workspace: UiWorkspaceGit): void {
    if (this.disposed) return;
    this.workspace = sanitizeTerminalText(workspace.path);
    this.gitLabel = workspaceGitLabel(workspace);
    this.options.onInvalidate?.();
  }

  requestForkSelection(
    points: readonly UiForkPoint[],
    currentSessionId: string,
  ): Promise<SessionForkSelection | undefined> {
    if (this.dialog) return Promise.reject(new Error("Another dialog is already open"));
    return new Promise((resolve) => {
      this.resolveVersionDialog = resolve;
      const picker = new SessionForkPicker(points, {
        currentSessionId,
        theme: this.theme,
        onComplete: (selection) => this.completeVersionDialog(selection),
      });
      this.dialog = new Dialog(this.baseView, picker, {
        open: true,
        title: "Session 分支",
        width: 100,
        height: 25,
        dismissOnEscape: false,
        borderStyle: this.theme.borderAccent,
        titleStyle: this.theme.accent,
      });
      this.dialogKind = "fork";
      this.synchronizeDialog();
      this.options.onInvalidate?.();
    });
  }

  requestChanges(
    diff: UiWorkspaceDiff,
    operations: {
      readonly onRestore?: (path: string) => Promise<UiWorkspaceDiff>;
      readonly onApply?: (previewId: string) => Promise<void>;
    } = {},
  ): Promise<void> {
    if (this.dialog) return Promise.reject(new Error("Another dialog is already open"));
    return new Promise((resolve) => {
      this.resolveVersionDialog = () => resolve();
      const viewer = new WorkspaceDiffViewer(diff, {
        theme: this.theme,
        onClose: () => this.completeVersionDialog(),
        ...operations,
        onInvalidate: () => this.options.onInvalidate?.(),
      });
      this.dialog = new Dialog(this.baseView, viewer, {
        open: true,
        title: "文件变化",
        width: 110,
        height: 30,
        dismissOnEscape: false,
        borderStyle: this.theme.borderAccent,
        titleStyle: this.theme.accent,
      });
      this.dialogKind = "changes";
      this.synchronizeDialog();
      this.options.onInvalidate?.();
    });
  }

  private completeVersionDialog(selection?: SessionForkSelection): void {
    this.dialog = undefined;
    this.dialogKind = undefined;
    const resolve = this.resolveVersionDialog;
    this.resolveVersionDialog = undefined;
    resolve?.(selection);
    this.openCurrentApproval();
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
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.transcript.dispose();
    this.editor.dispose?.();
    this.dialog?.dispose();
    if (this.lastDialog !== this.dialog) this.lastDialog?.dispose();
    this.focus.clear();
    this.dialog = undefined;
    this.dialogKind = undefined;
    for (const question of this.mcpQuestions.splice(0)) question.finish();
    this.resolveSessionDialog?.(undefined);
    this.resolveSessionDialog = undefined;
    this.resolveModelDialog?.(undefined);
    this.resolveModelDialog = undefined;
    this.resolveEffortDialog?.(undefined);
    this.resolveEffortDialog = undefined;
    this.resolveVersionDialog?.();
    this.resolveVersionDialog = undefined;
    this.suggestionVersion += 1;
    for (const approval of this.approvalQueue.splice(0)) {
      approval.resolve(undefined);
    }
  }

  private renderBase(size: RenderSize): RenderResult {
    const suggestionHeight = this.suggestionsVisible ? Math.min(7, this.suggestions.length + 2) : 0;
    this.layout.setItems([
      {
        height: 3,
        component: new HeaderView(this.workspace, this.model, this.theme),
      },
      { flex: 1, minHeight: 1, component: this.transcriptRegion },
      ...(suggestionHeight === 0
        ? []
        : [
            {
              height: suggestionHeight,
              component: new Panel(this.suggestionList, {
                title: " Commands ",
                borderStyle: this.theme.border,
                titleStyle: this.theme.accent,
              }),
            },
          ]),
      {
        height: 4,
        component: this.editorRegion,
      },
      {
        height: 1,
        component: new FooterView(
          this.options.permissionMode?.() === "yolo",
          this.status,
          this.focus.focusedId,
          this.transcriptView.toolDetailsMode,
          this.transcriptView.showReasoning,
          this.theme,
          this.shortcutHint("app.reply.start"),
          this.shortcutHint("app.tools.toggle"),
          this.shortcutHint("app.thinking.toggle"),
          this.gitLabel,
        ),
      },
    ]);
    return this.layout.render(size);
  }

  private handleBaseKey(stroke: KeyStroke): boolean {
    if (stroke.key === "wheelup" || stroke.key === "wheeldown") {
      this.resetInputContext();
      this.transcript.scrollBy(stroke.key === "wheelup" ? -3 : 3);
      return true;
    }
    if (
      this.focus.focusedId === "editor" &&
      this.editor.hasSelection &&
      stroke.ctrl &&
      stroke.key === "c" &&
      this.editor.handleKey(stroke)
    ) {
      this.keymap.reset();
      this.clearShortcutHint();
      return true;
    }
    const shortcut = this.keymap.resolve(
      stroke,
      this.transcriptView.hasSelection ? ["global", "transcript.selection"] : ["global"],
    );
    if (shortcut.type === "pending") {
      this.statusBeforeShortcut ??= this.status;
      this.status = `Shortcut: ${shortcut.completions.join(" / ")}`;
      this.options.onInvalidate?.();
      return true;
    }
    this.clearShortcutHint();
    if (shortcut.type === "action") {
      if (shortcut.action === "app.selection.copy") {
        const text = this.transcriptView.selectedText;
        if (this.options.clipboard === undefined) {
          this.setStatus("Error: Clipboard is unavailable");
        } else {
          this.pendingClipboard = this.options.clipboard.writeText(text).then(
            () => this.setStatus("Copied"),
            (error) => this.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
        return true;
      }
      if (shortcut.action === "app.interrupt") {
        this.submissionEpoch++;
        this.options.onCancel?.();
        return true;
      }
      if (shortcut.action === "app.focus.next" || shortcut.action === "app.focus.previous") {
        if (!(stroke.key === "tab" && this.suggestionsVisible && !stroke.shift)) {
          this.resetInputContext();
          this.transcript.clearPointerSelection();
          this.editor.clearSelection();
          const changed =
            shortcut.action === "app.focus.previous" ? this.focus.focusPrevious() : this.focus.focusNext();
          if (this.focus.focusedId === "transcript") this.ensureSelectedToolVisible();
          return changed;
        }
      }
      if (shortcut.action === "app.reply.start") {
        if (this.transcriptView.revealLatestReply()) {
          this.transcript.scrollToAnchor(() => this.transcriptView.latestReplyAnchor);
          this.setStatus("Reply start");
        } else {
          this.setStatus("No final reply yet");
        }
        return true;
      }
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
      if (
        this.suggestionsVisible &&
        isSuggestionNavigation(stroke.key) &&
        stroke.key !== "home" &&
        stroke.key !== "end" &&
        !stroke.shift &&
        !stroke.ctrl &&
        !stroke.alt
      ) {
        return this.suggestionList.handleKey(stroke);
      }
      if (stroke.key === "tab" && !stroke.shift) {
        this.completeSuggestion(false);
        return true;
      }
      if (
        stroke.key === "enter" &&
        this.suggestionsVisible &&
        !stroke.shift &&
        !stroke.ctrl &&
        !stroke.alt &&
        !stroke.meta
      ) {
        this.completeSuggestion(true);
        return true;
      }
    }
    const transcriptInteraction =
      stroke.key === "j" ||
      stroke.key === "k" ||
      stroke.key === "enter" ||
      stroke.key === "space" ||
      stroke.text === " ";
    const togglesSelectedTool =
      this.focus.focusedId === "transcript" &&
      (stroke.key === "enter" || stroke.key === "space" || stroke.text === " ");
    if (togglesSelectedTool) this.preserveSelectedToolPosition();
    const handled = this.focus.dispatch(stroke);
    if (handled && this.focus.focusedId === "editor") this.transcript.clearPointerSelection();
    if (handled && this.focus.focusedId === "transcript" && transcriptInteraction) {
      this.ensureSelectedToolVisible();
      if (stroke.key === "enter" || stroke.key === "space" || stroke.text === " ") {
        this.status = "Selected tool details toggled";
      }
    }
    return handled;
  }

  private submit(value: string, completeCommand = true): void {
    if (this.disposed || value.trim() === "") return;
    this.inputHistory.record(value);
    this.editor.setValue("");
    this.hideSuggestions();
    this.setStatus("Running");
    const epoch = this.submissionEpoch;
    const submit = () =>
      this.disposed || epoch !== this.submissionEpoch
        ? undefined
        : this.resolveSubmission(value, completeCommand, epoch);
    const previous = this.submissionTail;
    const pending = (previous ? previous.then(submit) : Promise.resolve(submit()))
      .then(
        (status) => {
          if (epoch === this.submissionEpoch)
            this.setStatus(status ?? (this.options.isRunning?.() ? "Running" : "Ready"));
        },
        (error: unknown) => {
          if (this.disposed || epoch !== this.submissionEpoch) return;
          if (this.editor.value === "") this.editor.setValue(value);
          this.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        },
      )
      .finally(() => {
        if (this.submissionTail === pending) this.submissionTail = undefined;
      });
    this.submissionTail = pending;
  }

  private async resolveSubmission(value: string, completeCommand: boolean, epoch: number): Promise<string | undefined> {
    let submission = value;
    if (completeCommand && value.startsWith("/")) {
      const suggestions = await this.suggestionsFor(value);
      submission = suggestions.length === 1 ? suggestions[0]!.value : value;
    }
    if (this.disposed || epoch !== this.submissionEpoch) return undefined;
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
        this.suggestionList.setItems(
          suggestions.map((suggestion) => ({
            value: suggestion,
            label: suggestion.label,
            ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
          })),
        );
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
    if (this.disposed) return;
    if (this.dialog !== undefined) return;
    const pending = this.approvalQueue[0];
    if (pending === undefined) {
      this.dialog = undefined;
      const question = this.mcpQuestions[0];
      if (question !== undefined) {
        this.dialog = new Dialog(
          this.baseView,
          new McpInputPrompt(question.prompt, question.finish, this.editorOptions(), this.options.keymap),
          {
            open: true,
            title: "MCP user interaction — untrusted server",
            width: 92,
            height: 24,
            dismissOnEscape: false,
            borderStyle: this.theme.warning,
            titleStyle: this.theme.warning,
          },
        );
        this.dialogKind = "mcp";
        this.synchronizeDialog();
        this.options.onInvalidate?.();
      }
      return;
    }
    const prompt = new ApprovalPrompt(
      pending.request,
      this.theme,
      (decision) => {
        const current = this.approvalQueue.shift();
        this.dialog = undefined;
        this.dialogKind = undefined;
        current?.resolve(decision);
        this.openCurrentApproval();
        this.options.onInvalidate?.();
      },
      this.options.keymap,
    );
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
    this.synchronizeDialog();
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
    this.transcript.preserveAnchor(anchor, () => this.transcriptView.selectedToolAnchor);
  }

  private executeUiAction(id: string): void {
    const status = this.uiActions.execute(id);
    if (status !== undefined) this.setStatus(status);
  }

  private async suggestionsFor(value: string): Promise<readonly MaybeCodeSlashCommandSuggestion[]> {
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

function isSuggestionNavigation(key: string): boolean {
  return key === "up" || key === "down" || key === "pageup" || key === "pagedown" || key === "home" || key === "end";
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
