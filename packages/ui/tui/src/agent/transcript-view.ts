import { Keymap, mergeKeyBindings, type KeyBindingDefinition, type KeyStroke } from "@may/keybindings";
import { diffChars, type Change } from "diff";
import type {
  Component,
  FocusTarget,
  InteractiveComponent,
  RenderResult,
  RenderSize,
  PointerEvent,
} from "../component.js";
import { Markdown } from "../markdown.js";
import { placeImages, type ImagePlacement } from "../component.js";
import type { TerminalImages } from "../images.js";
import type { ScrollRegion } from "../scroll-view.js";
import { Stack } from "../stack.js";
import { sanitizeTerminalText, Text } from "../text.js";
import { DEFAULT_DARK_THEME, styleText, type TuiTheme } from "../theme.js";
import { highlightTextRow, renderTextDocument, textRowOffset, type TextRow } from "../text-selection.js";
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
  readonly keybindings?: readonly KeyBindingDefinition[];
  readonly images?: TerminalImages;
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

export const TRANSCRIPT_KEYBINDINGS: readonly KeyBindingDefinition[] = [
  { context: "transcript", keys: "j", action: "tool.next" },
  { context: "transcript", keys: "k", action: "tool.previous" },
  { context: "transcript", keys: "enter", action: "tool.toggle" },
  { context: "transcript", keys: "space", action: "tool.toggle" },
];

export class TranscriptView implements InteractiveComponent, FocusTarget {
  private readonly keymap: Keymap;
  private textRows: readonly (TextRow | undefined)[] = [];
  private readonly sources = new Map<string, readonly TextRow[]>();
  private selectionStart: TextAnchor | undefined;
  private selectionEnd: TextAnchor | undefined;
  private dragging = false;
  private reasoningVisible: boolean;
  private toolDetailsVisible: boolean;
  private focused = false;
  private selectedToolId: string | undefined;
  private readonly toolDetailOverrides = new Map<string, boolean>();
  private readonly toolAnchors = new Map<string, ScrollRegion>();
  private revealedReplyId: string | undefined;
  private replyAnchor: ScrollRegion | undefined;
  private readonly theme: TuiTheme;
  private readonly toolRenderers: ToolRendererRegistry;
  private tailCache = new WeakMap<TranscriptItem, {
    key: string;
    lines: readonly string[];
    images?: readonly ImagePlacement[];
    replyStart?: number;
    textRows?: readonly (TextRow | undefined)[];
  }>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly options: TranscriptViewOptions = {},
  ) {
    this.keymap = new Keymap(mergeKeyBindings(TRANSCRIPT_KEYBINDINGS, options.keybindings), {
      actions: TRANSCRIPT_KEYBINDINGS.map(binding => binding.action),
    });
    this.reasoningVisible = options.showReasoning ?? true;
    this.toolDetailsVisible = options.showToolDetails ?? false;
    this.theme = options.theme ?? DEFAULT_DARK_THEME;
    this.toolRenderers = options.toolRenderers ?? createCodingToolRendererRegistry();
  }

  get showReasoning(): boolean {
    return this.reasoningVisible;
  }

  get hasSelection(): boolean {
    return this.selectedText !== "";
  }

  get selectedText(): string {
    const range = this.selectionRange();
    if (range === undefined) return "";
    return range.sources.slice(range.startIndex, range.endIndex + 1).map((source, index) => {
      const start = index === 0 ? range.start.offset : 0;
      const end = index === range.endIndex - range.startIndex ? range.end.offset : source.source.length;
      return source.source.slice(start, end);
    }).join("\n\n");
  }

  clearSelection(): void {
    this.selectionStart = undefined;
    this.selectionEnd = undefined;
    this.dragging = false;
  }

  dispose(): void {
    this.clearSelection();
    this.textRows = [];
    this.sources.clear();
    this.toolAnchors.clear();
    this.tailCache = new WeakMap();
  }

  handlePointer(event: PointerEvent): boolean {
    if (event.type === "down" && event.button !== 0) return false;
    if (event.type !== "down" && !this.dragging) return false;
    const anchor = this.pointerAnchor(event.x, event.y);
    if (anchor === undefined) {
      if (event.type === "down") this.clearSelection();
      if (event.type === "up") this.dragging = false;
      return false;
    }
    if (event.type === "down") {
      if (!event.shift || this.selectionStart === undefined) this.selectionStart = anchor;
      this.dragging = true;
    }
    this.selectionEnd = anchor;
    if (event.type === "up") this.dragging = false;
    return true;
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

  /** 最近一次渲染中，当前最终回复正文的第一行。 */
  get latestReplyAnchor(): ScrollRegion | undefined {
    return this.revealedReplyId === this.store.latestReply?.id ? this.replyAnchor : undefined;
  }

  /** 保留最终回复的完整正文，使其开头可以通过滚动定位。 */
  revealLatestReply(): boolean {
    const reply = this.store.latestReply;
    if (reply === undefined) return false;
    this.revealedReplyId = reply.id;
    return true;
  }

  setFocused(focused: boolean): void {
    if (this.focused !== focused) this.keymap.reset();
    this.focused = focused;
    if (focused) this.ensureSelectedTool();
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.focused) return false;
    const result = this.keymap.resolve(stroke, ["transcript"]);
    if (result.type !== "action") return result.type === "pending";
    if (result.action === "tool.next") return this.moveToolSelection(1);
    if (result.action === "tool.previous") return this.moveToolSelection(-1);
    return this.toggleSelectedTool();
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
    return this.highlightSelection(this.renderItems(size, false));
  }

  /** ScrollView hook: retain the latest rows when the bounded buffer overflows. */
  renderTail(size: RenderSize): RenderResult {
    return this.highlightSelection(this.renderItems(size, true));
  }

  private pointerAnchor(x: number, y: number): TextAnchor | undefined {
    if (this.textRows.length === 0) return undefined;
    const rowIndex = Math.max(0, Math.min(this.textRows.length - 1, y));
    const row = this.textRows[rowIndex];
    if (row !== undefined) return { sourceId: row.sourceId, offset: textRowOffset(row, x) };
    for (let index = rowIndex + 1; index < this.textRows.length; index++) {
      const next = this.textRows[index];
      if (next !== undefined) return { sourceId: next.sourceId, offset: next.start };
    }
    for (let index = rowIndex - 1; index >= 0; index--) {
      const previous = this.textRows[index];
      if (previous !== undefined) return { sourceId: previous.sourceId, offset: previous.end };
    }
    return undefined;
  }

  private selectionRange() {
    const sources = this.store.items.flatMap(item => this.sources.get(item.id) ?? []);
    const first = this.selectionStart;
    const last = this.selectionEnd;
    if (first === undefined || last === undefined) return undefined;
    const firstIndex = sources.findIndex(row => row.sourceId === first.sourceId);
    const lastIndex = sources.findIndex(row => row.sourceId === last.sourceId);
    if (firstIndex < 0 || lastIndex < 0) return undefined;
    const forward = firstIndex < lastIndex || (firstIndex === lastIndex && first.offset <= last.offset);
    return { sources, start: forward ? first : last, end: forward ? last : first,
      startIndex: forward ? firstIndex : lastIndex, endIndex: forward ? lastIndex : firstIndex };
  }

  private rememberSources(item: TranscriptItem, result: RenderResult): void {
    const unique = new Map<string, TextRow>();
    for (const row of result.textRows ?? []) if (row !== undefined) unique.set(row.sourceId, row);
    for (const previous of this.sources.get(item.id) ?? []) {
      const current = unique.get(previous.sourceId);
      if (current === undefined || current.source.startsWith(previous.source)) continue;
      const range = this.selectionRange();
      if (range === undefined || (this.selectionStart?.sourceId !== current.sourceId && this.selectionEnd?.sourceId !== current.sourceId)) continue;
      const changes = diffChars(previous.source, current.source);
      const update = (anchor: TextAnchor | undefined): TextAnchor | undefined => anchor?.sourceId !== current.sourceId ? anchor
        : { ...anchor, offset: changedOffset(changes, anchor.offset, anchor === range.start ? "right" : "left") };
      this.selectionStart = update(this.selectionStart);
      this.selectionEnd = update(this.selectionEnd);
    }
    this.sources.set(item.id, [...unique.values()]);
  }

  private highlightSelection(result: RenderResult): RenderResult {
    this.textRows = result.textRows ?? [];
    const ids = new Set(this.store.items.map(item => item.id));
    for (const id of this.sources.keys()) if (!ids.has(id)) this.sources.delete(id);
    const range = this.selectionRange();
    if (range === undefined) return result;
    const sources = new Map(range.sources.map((source, index) => [source.sourceId, index]));
    return { ...result, lines: result.lines.map((line, index) => {
      const row = this.textRows[index];
      const sourceIndex = row === undefined ? undefined : sources.get(row.sourceId);
      if (row === undefined || sourceIndex === undefined || sourceIndex < range.startIndex || sourceIndex > range.endIndex) return line;
      return highlightTextRow(line, row, sourceIndex === range.startIndex ? range.start.offset : 0,
        sourceIndex === range.endIndex ? range.end.offset : row.source.length);
    }) };
  }

  private renderItems(size: RenderSize, retainTail: boolean): RenderResult {
    this.replyAnchor = undefined;
    if (this.store.items.length === 0) {
      return new Text(sanitizeTerminalText(this.options.emptyMessage ?? "No messages yet."), {
        style: this.theme.dim,
      }).render(size);
    }
    this.ensureSelectedTool();
    this.toolAnchors.clear();
    if (retainTail) return this.renderTailItems(size);
    const lines: string[] = [];
    const images: ImagePlacement[] = [];
    const textRows: Array<TextRow | undefined> = [];
    for (const item of this.store.items) {
      if (lines.length >= size.height) break;
      if (lines.length > 0) { lines.push(""); textRows.push(undefined); }
      if (lines.length >= size.height) break;
      const start = lines.length;
      const selected = item.kind === "tool" && this.focused && item.id === this.selectedToolId;
      const result = new TranscriptItemView(item, {
        ...(this.options.images ? { images: this.options.images } : {}),
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
      textRows.push(...result.lines.map((_, index) => result.textRows?.[index]));
      this.rememberSources(item, result);
      images.push(...placeImages(result.images, start, size.height));
      if (item.kind === "tool") {
        this.toolAnchors.set(item.id, { start, end: start });
      }
    }
    return { lines, textRows, ...(images.length ? { images } : {}) };
  }

  private renderTailItems(size: RenderSize): RenderResult {
    const chunks: Array<{
      readonly item: TranscriptItem;
      readonly lines: readonly string[];
      readonly images?: readonly ImagePlacement[];
      readonly replyStart?: number;
      readonly textRows?: readonly (TextRow | undefined)[];
    }> = [];
    let remaining = size.height;
    const latestReply = this.store.latestReply;
    const revealedIndex = latestReply?.id === this.revealedReplyId
      ? this.store.items.findIndex((item) => item.id === this.revealedReplyId)
      : -1;
    for (let index = this.store.items.length - 1; index >= 0; index--) {
      const item = this.store.items[index]!;
      const separator = chunks.length === 0 ? 0 : 1;
      const available = remaining - separator;
      const revealReply = item.kind === "assistant" && index === revealedIndex;
      const keepForReply = revealedIndex >= 0 && index >= revealedIndex;
      if (available <= 0 && !keepForReply) break;
      const key = `${this.options.images?.revision}:${this.toolRenderers.revision}:${size.width}:${size.height}:${this.reasoningVisible}:${item.kind === "tool" && this.isToolExpanded(item.id)}:${this.focused && item.id === this.selectedToolId}:${revealReply}`;
      let cached = this.tailCache.get(item);
      if (cached?.key !== key) {
        const result = this.renderItem(item, size.width, Number.MAX_SAFE_INTEGER);
        this.rememberSources(item, result);
        const lines = result.lines;
        const bodyLines = revealReply
          ? item.kind === "assistant" && item.content?.some(part => part.type === "image")
            ? this.renderItem({ ...item, reasoning: "" }, size.width, Number.MAX_SAFE_INTEGER).lines.length - 1
            : new Markdown(item.text, { theme: this.theme.markdown }).render({ width: size.width, height: Number.MAX_SAFE_INTEGER }).lines.length
          : undefined;
        cached = { key, lines, ...(result.images ? { images: result.images } : {}),
          ...(result.textRows ? { textRows: result.textRows } : {}),
          ...(bodyLines === undefined ? {} : { replyStart: lines.length - bodyLines }) };
        this.tailCache.set(item, cached);
      }
      const rendered = cached.lines;
      const replyStart = cached.replyStart;
      const cut = keepForReply && !revealReply ? 0
        : Math.max(0, Math.min(rendered.length - available, replyStart ?? rendered.length));
      const visible = rendered.slice(cut);
      chunks.unshift({ item, lines: visible, ...(cached.images ? { images: placeImages(cached.images, -cut, visible.length) } : {}),
        ...(cached.textRows ? { textRows: cached.textRows.slice(cut) } : {}),
        ...(replyStart === undefined ? {} : { replyStart: replyStart - cut }) });
      remaining -= visible.length + separator;
      if (visible.length < rendered.length && (revealedIndex < 0 || index <= revealedIndex)) break;
    }

    const lines: string[] = [];
    const images: ImagePlacement[] = [];
    const textRows: Array<TextRow | undefined> = [];
    for (const chunk of chunks) {
      if (lines.length > 0) { lines.push(""); textRows.push(undefined); }
      const start = lines.length;
      lines.push(...chunk.lines);
      textRows.push(...chunk.lines.map((_, index) => chunk.textRows?.[index]));
      images.push(...placeImages(chunk.images, start, Number.MAX_SAFE_INTEGER));
      if (chunk.item.kind === "tool") {
        this.toolAnchors.set(chunk.item.id, { start, end: start });
      }
      if (chunk.replyStart !== undefined) {
        this.replyAnchor = { start: start + chunk.replyStart, end: start + chunk.replyStart };
      }
    }
    return { lines, textRows, ...(images.length ? { images } : {}) };
  }

  private renderItem(
    item: TranscriptItem,
    width: number,
    height: number,
  ): RenderResult {
    const selected = item.kind === "tool" && this.focused &&
      item.id === this.selectedToolId;
    return new TranscriptItemView(item, {
      ...(this.options.images ? { images: this.options.images } : {}),
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

interface TextAnchor {
  readonly sourceId: string;
  readonly offset: number;
}

function changedOffset(changes: readonly Change[], offset: number, affinity: "left" | "right"): number {
  let previous = 0;
  let current = 0;
  for (const change of changes) {
    if (change.added) {
      if (previous === offset && affinity === "left") return current;
      current += change.value.length;
      continue;
    }
    const end = previous + change.value.length;
    if (offset < end || (offset === end && affinity === "left")) {
      return current + (change.removed ? 0 : offset - previous);
    }
    previous = end;
    if (!change.removed) current += change.value.length;
  }
  return current;
}

interface TranscriptItemViewOptions {
  readonly images?: TerminalImages;
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
      case "tool": {
        const descriptionDocument = options.toolRenderers.renderDocument(this.item, {
          expanded: options.showToolDetails,
          selected: options.selected,
          maximumOutputCharacters: options.maximumToolOutputCharacters,
          theme: options.theme,
          detailsHint: options.selected
            ? options.selectedToolDetailsHint
            : options.toolDetailsHint,
        });
        const description: Component = {
          render: size => renderTextDocument(descriptionDocument, size, { sourceId: `${this.item.id}:tool` }),
        };
        const images = this.item.content?.filter(part => part.type === "image") ?? [];
        return new Stack([description, ...images.map((part, index) => options.images?.component(part.source, `${this.item.id}:image:${index}`) ?? new Text("图片附件：宿主未配置 TerminalImages。"))]).render(size);
      }
      case "user":
        return new Text(renderUser(this.item, options), {
          sourceId: `${this.item.id}:user`,
          copyRanges: [undefined, ...sanitizeTerminalText(this.item.text).split("\n").map(line => ({ start: 2, end: line.length + 2 }))],
        }).render(size);
      case "approval":
        return new Text(renderApproval(this.item, options.theme), { sourceId: `${this.item.id}:approval` }).render(size);
      case "notice":
        return new Text(renderNotice(this.item, options.theme), {
          sourceId: `${this.item.id}:notice`,
          copyRanges: sanitizeTerminalText(this.item.text).split("\n").map((line, index) => ({ start: index === 0 ? 2 : 0, end: line.length + (index === 0 ? 2 : 0) })),
        }).render(size);
    }
  }
}

function normalizeOptions(options: TranscriptViewOptions): TranscriptItemViewOptions {
  return {
    ...(options.images ? { images: options.images } : {}),
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
      sourceId: `${item.id}:reasoning`,
      copyRanges: sanitizeTerminalText(item.reasoning).split("\n").map(line => ({ start: 2, end: line.length + 2 })),
    }));
  }
  const value = item.text === "" && item.status === "streaming" ? "…" : item.text;
  if (value !== "" || item.content?.some(part => part.type === "image")) {
    children.push(new Text(
      `${styleText("◆", options.theme.accent)} ` +
        styleText(
          sanitizeTerminalText(options.assistantLabel),
          options.theme.assistantLabel,
        ),
    ));
    if (item.content?.some(part => part.type === "image")) {
      for (const [index, part] of item.content.entries()) {
        if (part.type === "text") children.push(new Markdown(part.text, { theme: options.theme.markdown, sourceId: `${item.id}:text:${index}` }));
        else if (part.type === "image") children.push(options.images?.component(part.source, `${item.id}:image:${index}`) ?? new Text("图片附件：宿主未配置 TerminalImages。"));
      }
    } else children.push(new Markdown(value, { theme: options.theme.markdown, sourceId: `${item.id}:text:0` }));
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
  const scope = item.scopeDescription === undefined ? "" : `\n持续授权范围：${sanitizeTerminalText(item.scopeDescription)}${item.scopeId === undefined ? "" : `\n范围身份：${sanitizeTerminalText(item.scopeId)}`}`;
  if (item.status === "pending") {
    return `${styleText("?", theme.warning)} Approval required for ` +
      styleText(sanitizeTerminalText(item.toolName), theme.toolTitle) + scope;
  }
  if (item.status === "resolved") {
    return `${styleText("✓", theme.success)} Permission: ${item.decision ?? "resolved"}` + scope;
  }
  return `${styleText("!", theme.warning)} Permission cancelled` +
    (item.reason === undefined ? "" : `: ${sanitizeTerminalText(item.reason)}`) + scope;
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
