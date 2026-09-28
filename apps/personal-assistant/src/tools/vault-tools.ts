import type { Tool } from "@may/core";
import type { Vault } from "../vault/vault.js";
import {
  defineTool,
  optionalNumber,
  optionalString,
  optionalStringList,
  readObject,
  requiredString,
} from "./define.js";

export function createVaultTools(vault: Vault): readonly Tool[] {
  const search = defineTool<{
    query: string;
    limit?: number;
    tags?: readonly string[];
    prefix?: string;
  }, {
    hits: readonly unknown[];
    total: number;
  }>({
    name: "vault_search",
    description:
      "在个人数据库中检索资料。返回命中片段、文件路径和行号区间，引用资料时用 vault_read 读取完整段落。" +
      "中文请用 2 到 4 个关键词，例如「成绩单 份数」。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        prefix: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "vault_search");
      return {
        query: requiredString(record, "query", "vault_search", 200),
        ...(optionalNumber(record, "limit", "vault_search") === undefined
          ? {}
          : { limit: optionalNumber(record, "limit", "vault_search")! }),
        ...(optionalStringList(record, "tags", "vault_search") === undefined
          ? {}
          : { tags: optionalStringList(record, "tags", "vault_search")! }),
        ...(optionalString(record, "prefix", "vault_search") === undefined
          ? {}
          : { prefix: optionalString(record, "prefix", "vault_search")! }),
      };
    },
    async execute(input) {
      const hits = await vault.search(input.query, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
      });
      return {
        total: hits.length,
        hits: hits.map((hit) => ({
          path: hit.path,
          title: hit.title,
          heading: hit.heading,
          lines: `${hit.startLine}-${hit.endLine}`,
          score: hit.score,
          text: hit.text,
        })),
      };
    },
  });

  const read = defineTool<{ path: string; startLine?: number; endLine?: number }, {
    path: string;
    lines: string;
    startLine: number;
    endLine: number;
    totalLines: number;
  }>({
    name: "vault_read",
    description: "读取个人数据库中某个文件的一段内容，输出带行号，用于核对检索结果和引用原文。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "vault_read");
      return {
        path: requiredString(record, "path", "vault_read", 400),
        ...(optionalNumber(record, "startLine", "vault_read") === undefined
          ? {}
          : { startLine: optionalNumber(record, "startLine", "vault_read")! }),
        ...(optionalNumber(record, "endLine", "vault_read") === undefined
          ? {}
          : { endLine: optionalNumber(record, "endLine", "vault_read")! }),
      };
    },
    async execute(input) {
      const result = await vault.read(input.path, {
        ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
        ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
      });
      return {
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        totalLines: result.totalLines,
        lines: numberLines(result.text, result.startLine),
      };
    },
  });

  const list = defineTool<{ prefix?: string; tag?: string; limit?: number }, { files: readonly unknown[] }>({
    name: "vault_list",
    description: "列出个人数据库中的文件，可按目录前缀或标签过滤。用于了解资料结构和已有记录。",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "vault_list");
      return {
        ...(optionalString(record, "prefix", "vault_list") === undefined
          ? {}
          : { prefix: optionalString(record, "prefix", "vault_list")! }),
        ...(optionalString(record, "tag", "vault_list") === undefined
          ? {}
          : { tag: optionalString(record, "tag", "vault_list")! }),
        ...(optionalNumber(record, "limit", "vault_list") === undefined
          ? {}
          : { limit: optionalNumber(record, "limit", "vault_list")! }),
      };
    },
    async execute(input) {
      const files = await vault.list({
        ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        files: files.map((file) => ({
          path: file.path,
          title: file.title,
          tags: file.tags,
          updatedAt: new Date(file.modifiedAt).toISOString(),
        })),
      };
    },
  });

  const write = defineTool<{ path: string; content: string; expectedHash?: string }, {
    path: string;
    hash: string;
    bytes: number;
  }>({
    name: "vault_write",
    description:
      "写入个人数据库中的 Markdown 文件。内容包含完整 YAML frontmatter（至少 title）。" +
      "覆盖已有文件时必须先 vault_read 并把返回的 hash 作为 expectedHash。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedHash: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "vault_write");
      return {
        path: requiredString(record, "path", "vault_write", 400),
        content: requiredString(record, "content", "vault_write", 1024 * 1024),
        ...(optionalString(record, "expectedHash", "vault_write") === undefined
          ? {}
          : { expectedHash: optionalString(record, "expectedHash", "vault_write")! }),
      };
    },
    async execute(input) {
      const entry = await vault.write(input.path, input.content, {
        ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
      });
      return { path: entry.path, hash: entry.hash, bytes: entry.bytes };
    },
  });

  const remove = defineTool<{ path: string }, { path: string; removed: boolean }>({
    name: "vault_remove",
    description: "删除个人数据库中的文件。需要用户确认，适合清理重复或过期的记录。",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "vault_remove");
      return { path: requiredString(record, "path", "vault_remove", 400) };
    },
    async execute(input) {
      return { path: input.path, removed: await vault.remove(input.path) };
    },
  });

  const commit = defineTool<{ message: string }, { committed: boolean; changes: number }>({
    name: "vault_commit",
    description: "把个人数据库当前的改动提交到 Git，方便回看助手做过的修改。",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "vault_commit");
      return { message: requiredString(record, "message", "vault_commit", 200) };
    },
    async execute(input) {
      const committed = await vault.git.commit(input.message);
      return { committed, changes: committed ? 1 : 0 };
    },
  });

  return [search, read, list, write, remove, commit];
}

function numberLines(text: string, startLine: number): string {
  return text.split("\n").map((line, index) => `${startLine + index}\t${line}`).join("\n");
}
