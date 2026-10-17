import { lexer, type Token, type Tokens } from "marked";
import { sanitizeTerminalText } from "./text.js";

export interface MarkdownExcerptOptions {
  /** 包含省略号的最大可见字符数量，按 grapheme 计算；换行不计数。 */
  readonly maxCharacters?: number;
  /** 自动换行之前的最大逻辑行数，包含空行。 */
  readonly maxLines?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 完整解析 Markdown 后生成纯文本节选，保留代码内容和 Unicode 字符。 */
export function renderMarkdownExcerpt(source: string, options: MarkdownExcerptOptions = {}): string {
  const maxCharacters = options.maxCharacters ?? 400;
  const maxLines = options.maxLines ?? 6;
  for (const [name, value] of Object.entries({ maxCharacters, maxLines })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const plain = blocks(lexer(sanitizeTerminalText(source), { gfm: true, breaks: false }));
  const lines: string[] = [];
  for (const line of plain.split("\n")) {
    const value = line.trimEnd();
    if (value === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(value);
  }
  while (lines.at(-1) === "") lines.pop();
  const segments = Array.from(graphemes.segment(lines.join("\n")), part => part.segment);
  const visibleCount = segments.filter(value => value !== "\n").length;
  if (visibleCount <= maxCharacters && lines.length <= maxLines) return lines.join("\n");

  let result = "";
  let characters = 0;
  let lineCount = 1;
  for (const segment of segments) {
    if (segment === "\n") {
      if (lineCount === maxLines) break;
      lineCount++;
    } else {
      if (characters === maxCharacters - 1) break;
      characters++;
    }
    result += segment;
  }
  return `${result.trimEnd()}…`;
}

function blocks(tokens: readonly Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case "space":
      case "def":
      case "hr":
      case "checkbox":
        return "";
      case "heading":
      case "paragraph":
        return inline((token as Tokens.Heading | Tokens.Paragraph).tokens);
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens === undefined ? text.text : inline(text.tokens);
      }
      case "code":
        return (token as Tokens.Code).text;
      case "html":
        return (token as Tokens.HTML).text;
      case "blockquote":
        return blocks((token as Tokens.Blockquote).tokens);
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        return list.items.map((item, index) => {
          const prefix = `${list.ordered ? `${start + index}.` : "•"} ${item.task ? `[${item.checked ? "x" : " "}] ` : ""}`;
          return blocks(item.tokens).split("\n")
            .map((line, lineIndex) => `${lineIndex === 0 ? prefix : " ".repeat(prefix.length)}${line}`).join("\n");
        }).join("\n");
      }
      case "table": {
        const table = token as Tokens.Table;
        const headers = table.header.map(cell => inline(cell.tokens).replace(/\n/gu, " "));
        if (table.rows.length === 0) return headers.join("; ");
        return table.rows.map(row => row.map((cell, index) => {
          const value = inline(cell.tokens).replace(/\n/gu, " ");
          return headers[index] ? `${headers[index]}: ${value}` : value;
        }).join("; ")).join("\n");
      }
      default:
        throw new Error(`Unsupported Markdown block: ${token.type}`);
    }
  }).filter(value => value !== "").join("\n\n");
}

function inline(tokens: readonly Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens === undefined ? text.text : inline(text.tokens);
      }
      case "escape":
      case "codespan":
      case "html":
        return (token as Tokens.Escape | Tokens.Codespan | Tokens.Tag).text;
      case "strong":
      case "em":
      case "del":
        return inline((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens);
      case "br":
        return "\n";
      case "checkbox":
        return "";
      case "link": {
        const link = token as Tokens.Link;
        const label = inline(link.tokens);
        return label === link.href ? label : `${label} (${link.href})`;
      }
      case "image": {
        const image = token as Tokens.Image;
        const label = inline(image.tokens);
        return label ? `${label} (${image.href})` : image.href;
      }
      default:
        throw new Error(`Unsupported Markdown inline token: ${token.type}`);
    }
  }).join("");
}
