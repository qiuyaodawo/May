import { parseDocument, stringify } from "yaml";

export interface ParsedMarkdown {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/** 使用 YAML 解析 frontmatter，不自行实现分隔符语法。 */
export function parseMarkdown(source: string): ParsedMarkdown {
  const match = FRONTMATTER.exec(source);
  if (!match) return { data: {}, body: source.replace(/^\uFEFF/u, "") };

  const document = parseDocument(match[1]!, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`frontmatter YAML 无效：${document.errors[0]?.message ?? "未知错误"}`);
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frontmatter 必须是键值映射");
  }
  return { data: value as Record<string, unknown>, body: source.slice(match[0].length) };
}

export function formatMarkdown(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body.replace(/^\uFEFF/u, "");
  const header = stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${header}\n---\n\n${body.replace(/^\n+/u, "")}`;
}

export function readTitle(data: Record<string, unknown>, body: string, fallback: string): string {
  const value = data.title;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const heading = /^[ \t]{0,3}#[ \t]+(.+)$/mu.exec(body)?.[1]?.trim();
  return heading ?? fallback;
}

export function readTags(data: Record<string, unknown>): readonly string[] {
  const value = data.tags ?? data.keywords;
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，]/u) : [];
  return [...new Set(list
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => item.split(/[,，]/u))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== ""))].slice(0, 32);
}
