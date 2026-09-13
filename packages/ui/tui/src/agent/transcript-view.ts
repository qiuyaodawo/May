import type { KeyStroke } from "@may/keybindings";
import type {
  Component,
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "../component.js";
import { Markdown } from "../markdown.js";
import type { ScrollRegion } from "../scroll-view.js";
import { Stack } from "../stack.js";
import { sanitizeTerminalText, Text } from "../text.js";
import { DEFAULT_DARK_THEME, styleText, type TuiTheme } from "../theme.js";
import type {
  ApprovalTranscriptItem,
  AssistantTranscriptItem,
  NoticeTranscriptItem,
  TranscriptItem,
  TranscriptStore,
  UserTranscriptItem,
} from "./transcript-store.js";
import {
  createCodingToolRendererRegistry,
  type ToolRendererRegistry,
} from "./tool-renderers.js";

export interface TranscriptViewOptions {
  readonly showReasoning?: boolean;
  readonly showToolDetails?: boolean;
  readonly selected?: boolean;
  readonly maximumToolOutputCharacters?: number;
  readonly theme?: TuiTheme;
  readonly toolRenderers?: ToolRendererRegistry;
  /** Label shown above assistant messages. Defaults to "May". */
  readonly assistantLabel?: string;
  /** Label shown above user messages. Defaults to "You". */
  readonly userLabel?: string;
  readonly emptyMessage?: string;
  readonly selectedToolDetailsHint?: string;
  readonly toolDetailsHint?: string;
}

export class TranscriptView implements InteractiveComponent, FocusTarget {
  private reasoningVisible: boolean;
  private toolDetailsVisible: boolean;
  private focused = false;
  private selectedToolId: string | undefined;
  private readonly toolDetailOverrides = new Map<string, boolean>();
  private readonly toolAnchors = new Map<string, ScrollRegion>();
  private readonly theme: TuiTheme;
  private readonly toolRenderers: ToolRendererRegistry;
  private readonly tailCache = new WeakMap<TranscriptItem, { key: string; lines: readonly string[] }>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly options: TranscriptViewOptions = {},
  ) {
    this.reasoningVisible = options.showReasoning ?? true;
    this.toolDetailsVisible = options.showToolDetails ?? false;
    this.theme = options.theme ?? DEFAULT_DARK_THEME;
    this.toolRenderers = options.toolRenderers ?? createCodingToolRendererRegistry();
  }

  get showReasoning(): boolean {
    return this.reasoningVisible;
  }

  get showToolDetails(): boolean {
    return this.toolDetailsVisible;
  }

  get toolDetailsMode(): "all" | "off" | "custom" {
    if (this.toolDetailOverrides.size > 0) return "custom";
    return this.toolDetailsVisible ? "all" : "off";
  }

  get selectedToolAnchor(): ScrollRegion | undefined {
    return this.selectedToolId === undefined
      ? undefined
      : this.toolAnchors.get(this.selectedToolId);
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (focused) this.ensureSelectedTool();
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused || stroke.ctrl || stroke.alt || stroke.meta) return false;
    if (stroke.key === "j") return this.moveToolSelection(1);
    if (stroke.key === "k") return this.moveToolSelection(-1);
    if (stroke.key === "enter" || stroke.key === "space" || stroke.text === " ") {
      return this.toggleSelectedTool();
    }
    return false;
  }

  toggleReasoning(): boolean {
    this.reasoningVisible = !this.reasoningVisible;
    return this.reasoningVisible;
  }

  toggleToolDetails(): boolean {
    this.toolDetailsVisible = !this.toolDetailsVisible;
    this.toolDetailOverrides.clear();
    return this.toolDetailsVisible;
  }

  toggleSelectedTool(): boolean {
    this.ensureSelectedTool();
    const id = this.selectedToolId;
    if (id === undefined) return false;
    this.toolDetailOverrides.set(id, !this.isToolExpanded(id));
    return true;
  }

  render(size: RenderSize): RenderResult {
    return this.renderItems(size, false);
  }

  /** ScrollView hook: retain the latest rows when the bounded buffer overflows. */
  renderTail(size: RenderSize): RenderResult {
    return this.renderItems(size, true);
  }

  private renderItems(size: RenderSize, retainTail: boolean): RenderResult {
    if (this.store.items.length === 0) {
      return new Text(sanitizeTerminalText(this.options.emptyMessage ?? "No messages yet."), {
        style: this.theme.dim,
      }).render(size);
    }
    this.ensureSelectedTool();
    this.toolAnchors.clear();
    if (retainTail) return this.renderTailItems(size);
    const lines: string[] = [];
    for (const item of this.store.items) {
      if (lines.length >= size.height) break;
      if (lines.length > 0) lines.push("");
      if (lines.length >= size.height) break;
      const start = lines.length;
      const selected = item.kind === "tool" && this.focused && item.id === this.selectedToolId;
      const result = new TranscriptItemView(item, {
        showReasoning: this.reasoningVisible,
        showToolDetails: item.kind === "tool"
          ? this.isToolExpanded(item.id)
          : this.toolDetailsVisible,
        selected,
        maximumToolOutputCharacters: this.options.maximumToolOutputCharacters ?? 8_000,
        theme: this.theme,
        toolRenderers: this.toolRenderers,
        ...(this.options.assistantLabel === undefined
          ? {}
          : { assistantLabel: this.options.assistantLabel }),
        ...(this.options.userLabel === undefined
          ? {}
          : { userLabel: this.options.userLabel }),
        ...(this.options.selectedToolDetailsHint === undefined
          ? {}
          : { selectedToolDetailsHint: this.options.selectedToolDetailsHint }),
        ...(this.options.toolDetailsHint === undefined
          ? {}
          : { toolDetailsHint: this.options.toolDetailsHint }),
      }).render({ width: size.width, height: size.height - lines.length });
      lines.push(...result.lines.slice(0, size.height - lines.length));
      if (item.kind === "tool") {
        this.toolAnchors.set(item.id, { start, end: start });
      }
    }
    return { lines };
  }

  private renderTailItems(size: RenderSize): RenderResult {
    const chunks: Array<{
      readonly item: TranscriptItem;
      readonly lines: readonly string[];
    }> = [];
    let remaining = size.height;
    for (let index = this.store.items.length - 1; index >= 0; index--) {
      const item = this.store.items[index]!;
      const separator = chunks.length === 0 ? 0 : 1;
      const available = remaining - separator;
      if (available <= 0) break;
      const key = `${this.toolRenderers.revision}:${size.width}:${size.height}:${this.reasoningVisible}:${item.kind === "tool" && this.isToolExpanded(item.id)}:${this.focused && item.id === this.selectedToolId}`;
      let cached = this.tailCache.get(item);
      if (cached?.key !== key) {
        cached = { key, lines: this.renderItem(tailBoundItem(item, size.width, size.height), size.width, Number.MAX_SAFE_INTEGER).lines };
        this.tailCache.set(item, cached);
      }
      const rendered = cached.lines;
      const visible = rendered.length <= available
        ? rendered
        : rendered.slice(-available);
      chunks.unshift({ item, lines: visible });
      remaining -= visible.length + separator;
      if (visible.length < rendered.length) break;
    }

    const lines: string[] = [];
    for (const chunk of chunks) {
      if (lines.length > 0) lines.push("");
      const start = lines.length;
      lines.push(...chunk.lines);
      if (chunk.item.kind === "tool") {
        this.toolAnchors.set(chunk.item.id, { start, end: start });
      }
    }
    return { lines };
  }

  private renderItem(
    item: TranscriptItem,
    width: number,
    height: number,
  ): RenderResult {
    const selected = item.kind === "tool" && this.focused &&
      item.id === this.selectedToolId;
    return new TranscriptItemView(item, {
      showReasoning: this.reasoningVisible,
      showToolDetails: item.kind === "tool"
        ? this.isToolExpanded(item.id)
        : this.toolDetailsVisible,
      selected,
      maximumToolOutputCharacters: this.options.maximumToolOutputCharacters ??
        8_000,
      theme: this.theme,
      toolRenderers: this.toolRenderers,
      ...(this.options.assistantLabel === undefined
        ? {}
        : { assistantLabel: this.options.assistantLabel }),
      ...(this.options.userLabel === undefined
        ? {}
        : { userLabel: this.options.userLabel }),
      ...(this.options.selectedToolDetailsHint === undefined
        ? {}
        : { selectedToolDetailsHint: this.options.selectedToolDetailsHint }),
      ...(this.options.toolDetailsHint === undefined
        ? {}
        : { toolDetailsHint: this.options.toolDetailsHint }),
    }).render({ width, height });
  }

  private isToolExpanded(id: string): boolean {
    return this.toolDetailOverrides.get(id) ?? this.toolDetailsVisible;
  }

  private ensureSelectedTool(): void {
    const tools = this.store.items.filter((item) => item.kind === "tool");
    if (tools.length === 0) {
      this.selectedToolId = undefined;
      return;
    }
    if (tools.some((item) => item.id === this.selectedToolId)) return;
    this.selectedToolId = tools.at(-1)!.id;
  }

  private moveToolSelection(direction: -1 | 1): boolean {
    const tools = this.store.items.filter((item) => item.kind === "tool");
    if (tools.length === 0) return false;
    this.ensureSelectedTool();
    const current = tools.findIndex((item) => item.id === this.selectedToolId);
    const next = Math.min(tools.length - 1, Math.max(0, current + direction));
    this.selectedToolId = tools[next]!.id;
    return true;
  }
}

function tailBoundItem(
  item: TranscriptItem,
  width: number,
  maximumLines: number,
): TranscriptItem {
  const maximumCharacters = Math.max(1, width) * maximumLines;
  if (item.kind === "user" || item.kind === "notice") {
    return { ...item, text: tailText(item.text, maximumCharacters, maximumLines) };
  }
  if (item.kind === "assistant") {
    return {
      ...item,
      text: tailText(item.text, maximumCharacters, maximumLines),
      reasoning: tailText(item.reasoning, maximumCharacters, maximumLines),
    };
  }
  return item;
}

function tailText(
  value: string,
  maximumCharacters: number,
  maximumLines: number,
): string {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  let tail = lines.slice(-maximumLines).join("\n");
  if (tail.length <= maximumCharacters) return tail;
  let start = tail.length - maximumCharacters;
  if (/^[\uDC00-\uDFFF]$/u.test(tail[start] ?? "")) start += 1;
  tail = tail.slice(start);
  return tail;
}

interface TranscriptItemViewOptions {
  readonly showReasoning: boolean;
  readonly showToolDetails: boolean;
  readonly selected: boolean;
  readonly maximumToolOutputCharacters: number;
  readonly theme: TuiTheme;
  readonly toolRenderers: ToolRendererRegistry;
  readonly assistantLabel: string;
  readonly userLabel: string;
  readonly selectedToolDetailsHint: string;
  readonly toolDetailsHint: string;
}

export class TranscriptItemView implements Component {
  constructor(
    private readonly item: TranscriptItem,
    private readonly options: TranscriptViewOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const options = normalizeOptions(this.options);
    switch (this.item.kind) {
      case "assistant":
        return renderAssistantView(this.item, options, size);
      case "tool":
        return new Text(options.toolRenderers.render(this.item, {
          expanded: options.showToolDetails,
          selected: options.selected,
          maximumOutputCharacters: options.maximumToolOutputCharacters,
          theme: options.theme,
          detailsHint: options.selected
            ? options.selectedToolDetailsHint
            : options.toolDetailsHint,
        })).render(size);
      case "user":
        return new Text(renderUser(this.item, options)).render(size);
      case "approval":
        return new Text(renderApproval(this.item, options.theme)).render(size);
      case "notice":
        return new Text(renderNotice(this.item, options.theme)).render(size);
    }
  }
}

function normalizeOptions(options: TranscriptViewOptions): TranscriptItemViewOptions {
  return {
    showReasoning: options.showReasoning ?? true,
    showToolDetails: options.showToolDetails ?? false,
    selected: options.selected ?? false,
    maximumToolOutputCharacters: options.maximumToolOutputCharacters ?? 8_000,
    theme: options.theme ?? DEFAULT_DARK_THEME,
    toolRenderers: options.toolRenderers ?? createCodingToolRendererRegistry(),
    assistantLabel: options.assistantLabel ?? "May",
    userLabel: options.userLabel ?? "You",
    selectedToolDetailsHint: options.selectedToolDetailsHint ?? "Enter details",
    toolDetailsHint: options.toolDetailsHint ?? "Toggle details",
  };
}

function renderAssistantView(
  item: AssistantTranscriptItem,
  options: TranscriptItemViewOptions,
  size: RenderSize,
): RenderResult {
  const children: Component[] = [];
  if (options.showReasoning && item.reasoning !== "") {
    children.push(new Text("thinking", { style: options.theme.thinking }));
    children.push(new Text(indent(sanitizeTerminalText(item.reasoning)), {
      style: options.theme.thinking,
    }));
  }
  const value = item.text === "" && item.status === "streaming" ? "…" : item.text;
  if (value !== "") {
    children.push(new Text(
      `${styleText("◆", options.theme.accent)} ` +
        styleText(
          sanitizeTerminalText(options.assistantLabel),
          options.theme.assistantLabel,
        ),
    ));
    children.push(new Markdown(value, { theme: options.theme.markdown }));
  }
  return new Stack(children).render(size);
}

function renderUser(
  item: UserTranscriptItem,
  options: TranscriptItemViewOptions,
): string {
  const safe = sanitizeTerminalText(item.text);
  const label = sanitizeTerminalText(options.userLabel);
  return `${styleText("›", options.theme.accent)} ` +
    `${styleText(label, options.theme.userMessage)}\n` +
    styleLines(indent(safe), options.theme.text);
}

function renderApproval(item: ApprovalTranscriptItem, theme: TuiTheme): string {
  if (item.status === "pending") {
    return `${styleText("?", theme.warning)} Approval required for ` +
      styleText(sanitizeTerminalText(item.toolName), theme.toolTitle);
  }
  if (item.status === "resolved") {
    return `${styleText("✓", theme.success)} Permission: ${item.decision ?? "resolved"}`;
  }
  return `${styleText("!", theme.warning)} Permission cancelled` +
    (item.reason === undefined ? "" : `: ${sanitizeTerminalText(item.reason)}`);
}

function renderNotice(item: NoticeTranscriptItem, theme: TuiTheme): string {
  const marker = item.level === "error" ? "✗" : item.level === "warning" ? "!" : "•";
  const markerStyle = item.level === "error"
    ? theme.error
    : item.level === "warning"
    ? theme.warning
    : theme.accent;
  return `${styleText(marker, markerStyle)} ${styleLines(sanitizeTerminalText(item.text), theme.muted)}`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function styleLines(value: string, style: TuiTheme["text"]): string {
  return value.split("\n").map((line) => styleText(line, style)).join("\n");
}
