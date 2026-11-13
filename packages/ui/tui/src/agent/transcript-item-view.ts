import type { Component, RenderResult, RenderSize } from "../component.js";
import { Markdown } from "../markdown.js";
import type { TerminalImages } from "../images.js";
import { Stack } from "../stack.js";
import { sanitizeTerminalText, Text } from "../text.js";
import { DEFAULT_DARK_THEME, styleText, type TuiTheme } from "../theme.js";
import { renderTextDocument } from "../text-selection.js";
import type {
  ApprovalTranscriptItem,
  AssistantTranscriptItem,
  NoticeTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from "./transcript-store.js";
import { createCodingToolRendererRegistry, type ToolRendererRegistry } from "./tool-renderers.js";
import type { TranscriptViewOptions } from "./transcript-view.js";

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

/** @experimental */
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
          detailsHint: options.selected ? options.selectedToolDetailsHint : options.toolDetailsHint,
        });
        const description: Component = {
          render: (size) => renderTextDocument(descriptionDocument, size, { sourceId: `${this.item.id}:tool` }),
        };
        const images = this.item.content?.filter((part) => part.type === "image") ?? [];
        return new Stack([
          description,
          ...images.map(
            (part, index) =>
              options.images?.component(part.source, `${this.item.id}:image:${index}`) ??
              new Text("图片附件：宿主未配置 TerminalImages。"),
          ),
        ]).render(size);
      }
      case "user":
        return new Text(renderUser(this.item, options), {
          sourceId: `${this.item.id}:user`,
          copyRanges: [
            undefined,
            ...sanitizeTerminalText(this.item.text)
              .split("\n")
              .map((line) => ({ start: 2, end: line.length + 2 })),
          ],
        }).render(size);
      case "approval":
        return new Text(renderApproval(this.item, options.theme), { sourceId: `${this.item.id}:approval` }).render(
          size,
        );
      case "notice":
        return new Text(renderNotice(this.item, options.theme), {
          continuationIndent: 2,
          sourceId: `${this.item.id}:notice`,
          copyRanges: sanitizeTerminalText(this.item.text)
            .split("\n")
            .map((line, index) => ({ start: index === 0 ? 2 : 0, end: line.length + (index === 0 ? 2 : 0) })),
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
    children.push(
      new Text(indent(sanitizeTerminalText(item.reasoning)), {
        style: options.theme.thinking,
        sourceId: `${item.id}:reasoning`,
        copyRanges: sanitizeTerminalText(item.reasoning)
          .split("\n")
          .map((line) => ({ start: 2, end: line.length + 2 })),
      }),
    );
  }
  const value = item.text === "" && item.status === "streaming" ? "…" : item.text;
  if (value !== "" || item.content?.some((part) => part.type === "image")) {
    children.push(
      new Text(
        `${styleText("◆", options.theme.accent)} ` +
          styleText(sanitizeTerminalText(options.assistantLabel), options.theme.assistantLabel),
      ),
    );
    if (item.content?.some((part) => part.type === "image")) {
      for (const [index, part] of item.content.entries()) {
        if (part.type === "text")
          children.push(
            new Markdown(part.text, { theme: options.theme.markdown, sourceId: `${item.id}:text:${index}` }),
          );
        else if (part.type === "image")
          children.push(
            options.images?.component(part.source, `${item.id}:image:${index}`) ??
              new Text("图片附件：宿主未配置 TerminalImages。"),
          );
      }
    } else children.push(new Markdown(value, { theme: options.theme.markdown, sourceId: `${item.id}:text:0` }));
  }
  if (item.status === "interrupted") children.push(new Text("Reply interrupted", { style: options.theme.warning }));
  return new Stack(children).render(size);
}

function renderUser(item: UserTranscriptItem, options: TranscriptItemViewOptions): string {
  const safe = sanitizeTerminalText(item.text);
  const label = sanitizeTerminalText(options.userLabel);
  return (
    `${styleText("›", options.theme.accent)} ` +
    `${styleText(label, options.theme.userMessage)}\n` +
    styleLines(indent(safe), options.theme.text)
  );
}

function renderApproval(item: ApprovalTranscriptItem, theme: TuiTheme): string {
  const scope =
    item.scopeDescription === undefined
      ? ""
      : `\n持续授权范围：${sanitizeTerminalText(item.scopeDescription)}${item.scopeId === undefined ? "" : `\n范围身份：${sanitizeTerminalText(item.scopeId)}`}`;
  if (item.status === "pending") {
    return (
      `${styleText("?", theme.warning)} Approval required for ` +
      styleText(sanitizeTerminalText(item.toolName), theme.toolTitle) +
      scope
    );
  }
  if (item.status === "resolved") {
    return `${styleText("✓", theme.success)} Permission: ${item.decision ?? "resolved"}` + scope;
  }
  return (
    `${styleText("!", theme.warning)} Permission cancelled` +
    (item.reason === undefined ? "" : `: ${sanitizeTerminalText(item.reason)}`) +
    scope
  );
}

function renderNotice(item: NoticeTranscriptItem, theme: TuiTheme): string {
  const marker = item.level === "error" ? "✗" : item.level === "warning" ? "!" : "•";
  const markerStyle = item.level === "error" ? theme.error : item.level === "warning" ? theme.warning : theme.accent;
  return `${styleText(marker, markerStyle)} ${styleLines(sanitizeTerminalText(item.text), theme.muted)}`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function styleLines(value: string, style: TuiTheme["text"]): string {
  return value
    .split("\n")
    .map((line) => styleText(line, style))
    .join("\n");
}
