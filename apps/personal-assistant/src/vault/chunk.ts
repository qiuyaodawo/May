/** Markdown 分块：按标题切分，保留原文行号，便于回答时定位。 */
export interface MarkdownChunk {
  /** 标题层级路径，例如 "材料要求 > 照片"。 */
  readonly heading: string;
  /** 1 起始行号，包含标题行。 */
  readonly startLine: number;
  /** 结束行号，包含。 */
  readonly endLine: number;
  readonly text: string;
}

export interface ChunkOptions {
  /** 单块最大行数，超出后按行继续切分。 */
  readonly maxLines?: number;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/u;
const FENCE = /^[ \t]{0,3}(?:```|~~~)/u;

export function chunkMarkdown(body: string, options: ChunkOptions = {}): MarkdownChunk[] {
  const maxLines = options.maxLines ?? 80;
  const lines = body.split("\n");
  const chunks: MarkdownChunk[] = [];
  const stack: string[] = [];
  let fenced = false;
  let start = 0;
  let heading = "";

  const flush = (end: number, from: number) => {
    for (let first = from; first < end; first += maxLines) {
      const last = Math.min(first + maxLines, end);
      const text = lines.slice(first, last).join("\n").trim();
      if (text === "") continue;
      chunks.push({ heading, startLine: first + 1, endLine: last, text });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (!match) continue;

    flush(index, start);
    const level = match[1]!.length;
    stack.length = Math.max(0, level - 1);
    stack[level - 1] = match[2]!.trim();
    heading = stack.filter((item) => item !== undefined && item !== "").join(" > ");
    start = index;
  }
  flush(lines.length, start);
  return chunks;
}

/** 去掉标记符号，保留可读文本，用于索引和摘要。 */
export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gmu, "")
    .replace(/^[ \t]{0,3}>\s?/gmu, "")
    .replace(/[*_~]{1,3}/gu, "")
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gmu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}
