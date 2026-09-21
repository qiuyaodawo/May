import { lexer, type Token, type Tokens } from "marked";
import { stripVTControlCharacters } from "node:util";
import type { Component, RenderResult, RenderSize } from "./component.js";
import { sanitizeTerminalText } from "./text.js";
import { renderTextDocument, type TextDocumentLine } from "./text-selection.js";
import {
  DEFAULT_DARK_THEME,
  styleText,
  type MarkdownTheme,
  type TextStyle,
} from "./theme.js";

export interface MarkdownOptions {
  readonly colors?: boolean;
  readonly theme?: MarkdownTheme;
  readonly sourceId?: string;
}

/** Safe terminal Markdown rendering backed by Marked's lexer, not its HTML output. */
export class Markdown implements Component {
  constructor(
    private readonly value: string | (() => string),
    private readonly options: MarkdownOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const source = typeof this.value === "function" ? this.value() : this.value;
    return renderTextDocument(markdownDocument(source, this.options), size, this.options);
  }
}

export function renderTerminalMarkdown(
  source: string,
  options: MarkdownOptions = {},
): string {
  return markdownDocument(source, options).map(line => line.value).join("\n");
}

function markdownDocument(source: string, options: MarkdownOptions): TextDocumentLine[] {
  const colors = options.colors ?? true;
  const theme = options.theme ?? DEFAULT_DARK_THEME.markdown;
  const tokens = lexer(sanitizeTerminalText(source), { gfm: true, breaks: false });
  const document = renderBlocks(tokens, colors, theme);
  while (document.at(-1)?.value === "") document.pop();
  const last = document.at(-1);
  if (last !== undefined) {
    const value = last.value.trimEnd();
    document[document.length - 1] = { value, ...(last.copy === undefined ? {} : {
      copy: { start: last.copy.start, end: Math.min(last.copy.end, stripVTControlCharacters(value).length) },
    }) };
  }
  return document.length === 0 ? [{ value: "", copy: { start: 0, end: 0 } }] : document;
}

function renderBlocks(
  tokens: readonly Token[],
  colors: boolean,
  theme: MarkdownTheme,
): TextDocumentLine[] {
  const blocks: TextDocumentLine[][] = [];
  for (const token of tokens) {
    let block: TextDocumentLine[] | undefined;
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const marker = heading.depth <= 2 ? `${"#".repeat(heading.depth)} ` : "";
        block = copyLines(style(
          `${marker}${renderInline(heading.tokens, colors, theme)}`,
          theme.heading,
          colors,
        ));
        break;
      }
      case "paragraph":
        block = copyLines(renderInline((token as Tokens.Paragraph).tokens, colors, theme));
        break;
      case "text": {
        const text = token as Tokens.Text;
        block = copyLines(text.tokens === undefined
          ? text.text
          : renderInline(text.tokens, colors, theme));
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang === undefined ? "" : ` [${code.lang}]`;
        const label = style(`┌─ code${language}`, theme.codeBlockBorder, colors);
        const body = code.text.split("\n").map((line) => ({
          value: `${style("│", theme.codeBlockBorder, colors)} ${style(line, theme.codeBlock, colors)}`,
          copy: { start: 2, end: 2 + line.length },
        }));
        block = [{ value: label }, ...body];
        break;
      }
      case "blockquote": {
        const quote = renderBlocks((token as Tokens.Blockquote).tokens, colors, theme);
        block = quote.map(line => ({
          value: `${style("│", theme.quoteBorder, colors)} ${style(line.value, theme.quote, colors)}`,
          ...(line.copy === undefined ? {} : { copy: { start: line.copy.start + 2, end: line.copy.end + 2 } }),
        }));
        break;
      }
      case "list":
        block = renderList(token as Tokens.List, colors, theme);
        break;
      case "hr":
        block = [{ value: style("────────", theme.horizontalRule, colors) }];
        break;
      case "table":
        block = renderTable(token as Tokens.Table, colors, theme);
        break;
      case "html":
        block = copyLines(stripHtml((token as Tokens.HTML).text));
        break;
      default:
        block = "raw" in token ? copyLines(sanitizeTerminalText(String(token.raw))) : undefined;
        break;
    }
    if (block !== undefined && block.some(line => line.value !== "")) blocks.push(block);
  }
  return blocks.flatMap((block, index) => index === 0 ? block : [{ value: "", copy: { start: 0, end: 0 } }, ...block]);
}

function renderInline(
  tokens: readonly Token[],
  colors: boolean,
  theme: MarkdownTheme,
): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens === undefined
          ? text.text
          : renderInline(text.tokens, colors, theme);
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return style(
          renderInline((token as Tokens.Strong).tokens, colors, theme),
          { bold: true },
          colors,
        );
      case "em":
        return style(
          renderInline((token as Tokens.Em).tokens, colors, theme),
          { italic: true },
          colors,
        );
      case "del":
        return style(
          renderInline((token as Tokens.Del).tokens, colors, theme),
          { strikethrough: true },
          colors,
        );
      case "codespan":
        return style((token as Tokens.Codespan).text, theme.code, colors);
      case "br":
        return "\n";
      case "link": {
        const link = token as Tokens.Link;
        const label = style(renderInline(link.tokens, colors, theme), theme.link, colors);
        return link.href === link.text
          ? label
          : `${label} ${style(`(${link.href})`, theme.linkUrl, colors)}`;
      }
      case "image": {
        const image = token as Tokens.Image;
        return `[image: ${image.text || "unnamed"}] (${image.href})`;
      }
      case "html":
        return stripHtml((token as Tokens.Tag).text);
      default:
        return "raw" in token ? sanitizeTerminalText(String(token.raw)) : "";
    }
  }).join("");
}

function renderList(
  list: Tokens.List,
  colors: boolean,
  theme: MarkdownTheme,
): TextDocumentLine[] {
  const start = typeof list.start === "number" ? list.start : 1;
  return list.items.flatMap((item, index) => {
    const task = item.task ? `[${item.checked ? "x" : " "}] ` : "";
    const marker = list.ordered ? `${start + index}. ` : "• ";
    const body = renderBlocks(item.tokens, colors, theme);
    const continuation = " ".repeat(marker.length + task.length);
    return body.map((line, lineIndex) => {
      const prefix = lineIndex === 0 ? `${style(marker, theme.listBullet, colors)}${task}` : continuation;
      return { value: prefix + line.value, ...(line.copy === undefined ? {} : {
        copy: { start: line.copy.start === 0 ? 0 : line.copy.start + continuation.length, end: line.copy.end + continuation.length },
      }) };
    });
  });
}

function renderTable(
  table: Tokens.Table,
  colors: boolean,
  theme: MarkdownTheme,
): TextDocumentLine[] {
  const row = (cells: readonly Tokens.TableCell[]) =>
    `| ${cells.map((cell) => renderInline(cell.tokens, colors, theme)).join(" | ")} |`;
  const header = row(table.header);
  const divider = `| ${table.header.map(() => "---").join(" | ")} |`;
  return [...copyLines(header), { value: divider }, ...table.rows.flatMap(cells => copyLines(row(cells)))];
}

function copyLines(value: string): TextDocumentLine[] {
  return value.split("\n").map(line => ({ value: line, copy: { start: 0, end: stripVTControlCharacters(line).length } }));
}

function style(value: string, textStyle: TextStyle, enabled: boolean): string {
  return enabled ? styleText(value, textStyle) : value;
}

function stripHtml(value: string): string {
  return sanitizeTerminalText(value.replace(/<[^>]*>/gu, ""));
}
