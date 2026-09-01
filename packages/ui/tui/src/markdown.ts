import { lexer, type Token, type Tokens } from "marked";
import type { Component, RenderResult, RenderSize } from "./component.js";
import { sanitizeTerminalText, Text } from "./text.js";
import {
  DEFAULT_DARK_THEME,
  styleText,
  type MarkdownTheme,
  type TextStyle,
} from "./theme.js";

export interface MarkdownOptions {
  readonly colors?: boolean;
  readonly theme?: MarkdownTheme;
}

/** Safe terminal Markdown rendering backed by Marked's lexer, not its HTML output. */
export class Markdown implements Component {
  constructor(
    private readonly value: string | (() => string),
    private readonly options: MarkdownOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const source = typeof this.value === "function" ? this.value() : this.value;
    return new Text(renderTerminalMarkdown(source, this.options)).render(size);
  }
}

export function renderTerminalMarkdown(
  source: string,
  options: MarkdownOptions = {},
): string {
  const colors = options.colors ?? true;
  const theme = options.theme ?? DEFAULT_DARK_THEME.markdown;
  const tokens = lexer(sanitizeTerminalText(source), { gfm: true, breaks: false });
  return renderBlocks(tokens, colors, theme).trimEnd();
}

function renderBlocks(
  tokens: readonly Token[],
  colors: boolean,
  theme: MarkdownTheme,
): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    let block: string | undefined;
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const marker = heading.depth <= 2 ? `${"#".repeat(heading.depth)} ` : "";
        block = style(
          `${marker}${renderInline(heading.tokens, colors, theme)}`,
          theme.heading,
          colors,
        );
        break;
      }
      case "paragraph":
        block = renderInline((token as Tokens.Paragraph).tokens, colors, theme);
        break;
      case "text": {
        const text = token as Tokens.Text;
        block = text.tokens === undefined
          ? text.text
          : renderInline(text.tokens, colors, theme);
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang === undefined ? "" : ` [${code.lang}]`;
        const label = style(`┌─ code${language}`, theme.codeBlockBorder, colors);
        const body = code.text.split("\n").map((line) =>
          `${style("│", theme.codeBlockBorder, colors)} ${style(line, theme.codeBlock, colors)}`
        ).join("\n");
        block = `${label}\n${body}`;
        break;
      }
      case "blockquote": {
        const quote = renderBlocks((token as Tokens.Blockquote).tokens, colors, theme);
        block = quote.split("\n").map((line) =>
          `${style("│", theme.quoteBorder, colors)} ${style(line, theme.quote, colors)}`
        ).join("\n");
        break;
      }
      case "list":
        block = renderList(token as Tokens.List, colors, theme);
        break;
      case "hr":
        block = style("────────", theme.horizontalRule, colors);
        break;
      case "table":
        block = renderTable(token as Tokens.Table, colors, theme);
        break;
      case "html":
        block = stripHtml((token as Tokens.HTML).text);
        break;
      default:
        block = "raw" in token ? sanitizeTerminalText(String(token.raw)) : undefined;
        break;
    }
    if (block !== undefined && block !== "") blocks.push(block);
  }
  return blocks.join("\n\n");
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
): string {
  const start = typeof list.start === "number" ? list.start : 1;
  return list.items.map((item, index) => {
    const task = item.task ? `[${item.checked ? "x" : " "}] ` : "";
    const marker = list.ordered ? `${start + index}. ` : "• ";
    const body = renderBlocks(item.tokens, colors, theme).split("\n");
    const continuation = " ".repeat(marker.length + task.length);
    return body.map((line, lineIndex) =>
      `${lineIndex === 0 ? `${style(marker, theme.listBullet, colors)}${task}` : continuation}${line}`
    ).join("\n");
  }).join("\n");
}

function renderTable(
  table: Tokens.Table,
  colors: boolean,
  theme: MarkdownTheme,
): string {
  const row = (cells: readonly Tokens.TableCell[]) =>
    `| ${cells.map((cell) => renderInline(cell.tokens, colors, theme)).join(" | ")} |`;
  const header = row(table.header);
  const divider = `| ${table.header.map(() => "---").join(" | ")} |`;
  return [header, divider, ...table.rows.map(row)].join("\n");
}

function style(value: string, textStyle: TextStyle, enabled: boolean): string {
  return enabled ? styleText(value, textStyle) : value;
}

function stripHtml(value: string): string {
  return sanitizeTerminalText(value.replace(/<[^>]*>/gu, ""));
}
