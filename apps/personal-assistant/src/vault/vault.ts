import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import MiniSearch, { type Options, type SearchResult } from "minisearch";
import { chunkMarkdown, plainText } from "./chunk.js";
import { GitRepository } from "./git.js";
import { formatMarkdown, parseMarkdown, readTags, readTitle } from "./frontmatter.js";
import { isMissing, resolveVaultPath } from "./paths.js";
import { tokenize } from "./tokenizer.js";

const INDEX_DIRECTORY = ".index";
const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNIPPET_CHARS = 1_200;
const MAX_LIST_LIMIT = 500;
const MAX_READ_LINES = 400;

export interface VaultEntry {
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly hash: string;
}

export interface VaultSearchOptions {
  readonly limit?: number;
  readonly tags?: readonly string[];
  readonly prefix?: string;
}

export interface VaultSearchHit {
  readonly path: string;
  readonly title: string;
  readonly heading: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly terms: readonly string[];
  readonly text: string;
}

export interface VaultReadResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly text: string;
}

export interface VaultSyncResult {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: number;
  readonly total: number;
}

export interface VaultStatus {
  readonly root: string;
  readonly files: number;
  readonly chunks: number;
  readonly lastSyncAt: number | undefined;
  readonly gitRepository: boolean;
  readonly pendingChanges: number;
}

interface VaultChunkDocument {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly tags: string;
  readonly heading: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface VaultFileState {
  readonly hash: string;
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly title: string;
  readonly tags: readonly string[];
}

interface PersistedIndex {
  readonly version: number;
  readonly files: Record<string, VaultFileState>;
  readonly chunks: Record<string, readonly string[]>;
  readonly index: ReturnType<MiniSearch<VaultChunkDocument>["toJSON"]>;
}

const SEARCH_OPTIONS = {
  prefix: true,
  combineWith: "OR" as const,
  boost: { title: 3, heading: 2, tags: 2 },
  // 单字词只用于保持召回，具体词形优先排在前面。
  boostTerm: (term: string) => (term.length <= 1 ? 0.3 : 1),
};

/**
 * Markdown 个人数据库：文件是唯一事实来源，索引可以随时重建。
 * 检索结果带原文行号，模型回答时可以引用到具体位置。
 */
export class Vault {
  readonly git: GitRepository;
  private index: MiniSearch<VaultChunkDocument>;
  private files = new Map<string, VaultFileState>();
  private chunks = new Map<string, string[]>();
  private tail: Promise<unknown> = Promise.resolve();
  private lastSyncAt: number | undefined;

  private constructor(readonly root: string) {
    this.git = new GitRepository(root);
    this.index = createIndex();
  }

  static async open(root: string): Promise<Vault> {
    await mkdir(root, { recursive: true });
    const vault = new Vault(root);
    await vault.git.init();
    await ensureIgnoreFile(join(root, ".gitignore"));
    await mkdir(join(root, INDEX_DIRECTORY), { recursive: true });
    await vault.loadIndex();
    await vault.sync();
    return vault;
  }

  /** 顺序执行，保证同一时刻只有一次索引更新在运行。 */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.tail.then(operation);
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  /** 比较文件状态并更新索引；状态未变化的文件不会重新读取。 */
  sync(): Promise<VaultSyncResult> {
    return this.serialize(() => this.syncNow());
  }

  private async syncNow(): Promise<VaultSyncResult> {
    const next = new Map<string, VaultFileState>();
    const changed = new Map<string, string>();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    let unchanged = 0;

    for (const path of await listMarkdownFiles(this.root)) {
      const known = this.files.get(path);
      const information = await stat(join(this.root, path));
      const modifiedAt = Math.floor(information.mtimeMs);
      if (known !== undefined && known.modifiedAt === modifiedAt && known.bytes === information.size) {
        next.set(path, known);
        unchanged += 1;
        continue;
      }
      if (information.size > MAX_FILE_BYTES) {
        throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节上限：${path}`);
      }
      const content = await readFile(join(this.root, path), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      if (known !== undefined && known.hash === hash) {
        next.set(path, { ...known, bytes: information.size, modifiedAt });
        unchanged += 1;
        continue;
      }
      (known === undefined ? added : updated).push(path);
      changed.set(path, content);
      next.set(path, { hash, bytes: information.size, modifiedAt, title: known?.title ?? "", tags: known?.tags ?? [] });
    }

    for (const path of this.files.keys()) {
      if (!next.has(path)) removed.push(path);
    }
    for (const path of removed) this.removeDocument(path);
    for (const [path, content] of changed) {
      this.removeDocument(path);
      next.set(path, this.addDocument(path, content, next.get(path)!));
    }

    this.files = next;
    this.lastSyncAt = Date.now();
    if (added.length + updated.length + removed.length > 0) await this.saveIndex();
    return { added, updated, removed, unchanged, total: this.files.size };
  }

  async search(query: string, options: VaultSearchOptions = {}): Promise<VaultSearchHit[]> {
    const text = query.trim();
    if (text === "") throw new Error("检索关键词不能为空");
    await this.sync();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const tags = (options.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== "");
    const prefix = options.prefix?.replace(/^\/+|\/+$/gu, "");

    const results: SearchResult[] = this.index.search(text, {
      ...SEARCH_OPTIONS,
      filter: (result) => {
        if (prefix !== undefined && prefix !== "" && !String(result.path).startsWith(prefix)) return false;
        if (tags.length === 0) return true;
        const documentTags = String(result.tags).split(" ").filter((tag) => tag !== "");
        return tags.every((tag) => documentTags.includes(tag));
      },
    });
    return results.slice(0, limit).map((result) => ({
      path: String(result.path),
      title: String(result.title),
      heading: String(result.heading),
      startLine: Number(result.startLine),
      endLine: Number(result.endLine),
      score: Math.round(Number(result.score) * 1000) / 1000,
      terms: result.terms,
      text: String(result.text),
    }));
  }

  async read(path: string, range: { startLine?: number; endLine?: number } = {}): Promise<VaultReadResult> {
    await this.sync();
    const resolved = await resolveVaultPath(this.root, path, { mustExist: true });
    const lines = (await readFile(resolved.absolute, "utf8")).split("\n");
    const startLine = Math.max(1, Math.min(range.startLine ?? 1, lines.length));
    const requestedEnd = range.endLine ?? lines.length;
    const endLine = Math.max(startLine, Math.min(requestedEnd, lines.length, startLine + MAX_READ_LINES - 1));
    return {
      path: resolved.relative,
      startLine,
      endLine,
      totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join("\n"),
    };
  }

  async list(options: { prefix?: string; tag?: string; limit?: number } = {}): Promise<VaultEntry[]> {
    await this.sync();
    const prefix = options.prefix?.replace(/^\/+|\/+$/gu, "");
    const tag = options.tag?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_LIST_LIMIT));
    const entries: VaultEntry[] = [];
    for (const [path, state] of this.files) {
      if (prefix !== undefined && prefix !== "" && !path.startsWith(prefix)) continue;
      if (tag !== undefined && tag !== "" && !state.tags.includes(tag)) continue;
      entries.push({
        path,
        title: state.title,
        tags: state.tags,
        bytes: state.bytes,
        modifiedAt: state.modifiedAt,
        hash: state.hash,
      });
    }
    entries.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
    return entries.slice(0, limit);
  }

  async entry(path: string): Promise<VaultEntry | undefined> {
    await this.sync();
    const resolved = await resolveVaultPath(this.root, path, { mustExist: true });
    const state = this.files.get(resolved.relative);
    return state === undefined
      ? undefined
      : { path: resolved.relative, ...state };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await resolveVaultPath(this.root, path, { mustExist: true });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "VaultPathError" && error.message.startsWith("文件不存在")) {
        return false;
      }
      throw error;
    }
  }

  /** 写入 Markdown 文件。覆盖已有文件时必须提供 expectedHash，避免丢失新改动。 */
  async write(
    path: string,
    content: string,
    options: { readonly expectedHash?: string } = {},
  ): Promise<VaultEntry> {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`内容超过 ${MAX_FILE_BYTES} 字节上限`);
    }
    return this.serialize(async () => {
      const resolved = await resolveVaultPath(this.root, path, { mustExist: false });
      const current = this.files.get(resolved.relative);
      if (options.expectedHash !== undefined) {
        if (current === undefined) throw new Error(`文件不存在，无法校验内容：${resolved.relative}`);
        if (current.hash !== options.expectedHash) {
          throw new Error(`文件已被修改，请重新读取后再写入：${resolved.relative}`);
        }
      }
      await mkdir(dirname(resolved.absolute), { recursive: true });
      await writeFile(resolved.absolute, content, "utf8");
      await this.syncNow();
      const state = this.files.get(resolved.relative);
      if (state === undefined) throw new Error(`写入后未能索引：${resolved.relative}`);
      return { path: resolved.relative, ...state };
    });
  }

  /** 按 frontmatter 修改文件，保留未提供的字段与正文。 */
  async update(
    path: string,
    change: { readonly title?: string; readonly tags?: readonly string[]; readonly body?: string },
  ): Promise<VaultEntry> {
    const resolved = await resolveVaultPath(this.root, path, { mustExist: true });
    const parsed = parseMarkdown(await readFile(resolved.absolute, "utf8"));
    const data: Record<string, unknown> = { ...parsed.data };
    if (change.title !== undefined) data.title = change.title;
    if (change.tags !== undefined) data.tags = [...change.tags];
    const expectedHash = this.files.get(resolved.relative)?.hash;
    return this.write(
      resolved.relative,
      formatMarkdown(data, change.body ?? parsed.body),
      expectedHash === undefined ? {} : { expectedHash },
    );
  }

  async remove(path: string): Promise<boolean> {
    return this.serialize(async () => {
      const resolved = await resolveVaultPath(this.root, path, { mustExist: true });
      await rm(resolved.absolute);
      await this.syncNow();
      return true;
    });
  }

  async status(): Promise<VaultStatus> {
    await this.sync();
    const repository = await this.git.isRepository();
    return {
      root: this.root,
      files: this.files.size,
      chunks: this.index.documentCount,
      lastSyncAt: this.lastSyncAt,
      gitRepository: repository,
      pendingChanges: repository ? await this.git.pendingChanges() : 0,
    };
  }

  private addDocument(
    path: string,
    content: string,
    state: { hash: string; bytes: number; modifiedAt: number },
  ): VaultFileState {
    const parsed = parseMarkdown(content);
    const fallback = (path.split("/").at(-1) ?? path).replace(/\.md$/u, "");
    const title = readTitle(parsed.data, parsed.body, fallback);
    const tags = readTags(parsed.data);
    const offset = frontmatterLineCount(content);
    const ids: string[] = [];

    for (const [index, chunk] of chunkMarkdown(parsed.body).entries()) {
      const id = `${path}#${index}-${chunk.startLine}`;
      ids.push(id);
      this.index.add({
        id,
        path,
        title,
        tags: tags.join(" "),
        heading: chunk.heading,
        startLine: chunk.startLine + offset,
        endLine: chunk.endLine + offset,
        text: plainText(chunk.text).slice(0, MAX_SNIPPET_CHARS),
      });
    }
    this.chunks.set(path, ids);
    const metadata: VaultFileState = { hash: state.hash, bytes: state.bytes, modifiedAt: state.modifiedAt, title, tags };
    this.files.set(path, metadata);
    return metadata;
  }

  private removeDocument(path: string): void {
    for (const id of this.chunks.get(path) ?? []) this.index.discard(id);
    this.chunks.delete(path);
    this.files.delete(path);
  }

  private async loadIndex(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, INDEX_DIRECTORY, INDEX_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    let persisted: PersistedIndex;
    try {
      persisted = JSON.parse(raw) as PersistedIndex;
    } catch {
      return;
    }
    if (persisted.version !== INDEX_VERSION) return;
    if (typeof persisted.files !== "object" || persisted.files === null) return;
    this.index = MiniSearch.loadJS(persisted.index, indexOptions());
    this.files = new Map(Object.entries(persisted.files));
    this.chunks = new Map(Object.entries(persisted.chunks ?? {}).map(([path, ids]) => [path, [...ids]]));
  }

  private async saveIndex(): Promise<void> {
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      files: Object.fromEntries(this.files),
      chunks: Object.fromEntries(this.chunks),
      index: this.index.toJSON(),
    };
    const target = join(this.root, INDEX_DIRECTORY, INDEX_FILE);
    const temporary = `${target}.pending`;
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, target);
  }
}

function createIndex(): MiniSearch<VaultChunkDocument> {
  return new MiniSearch<VaultChunkDocument>(indexOptions());
}

function indexOptions(): Options<VaultChunkDocument> {
  return {
    fields: ["title", "heading", "tags", "text"],
    storeFields: ["id", "path", "title", "tags", "heading", "startLine", "endLine", "text"],
    tokenize: (text: string) => tokenize(text),
    searchOptions: { ...SEARCH_OPTIONS },
  };
}

/** frontmatter 占用的行数，用于把正文行号换算成文件行号。 */
function frontmatterLineCount(content: string): number {
  const match = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  return match === null ? 0 : match[0].split("\n").length - 1;
}

/** 索引是可重建的缓存，不进入 Git 历史。 */
async function ensureIgnoreFile(path: string): Promise<void> {
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (existing === undefined) {
    await writeFile(path, `${INDEX_DIRECTORY}/\n`, "utf8");
    return;
  }
  if (!existing.split("\n").some((line) => line.trim() === `${INDEX_DIRECTORY}/`)) {
    await writeFile(path, `${existing.replace(/\n*$/u, "")}\n${INDEX_DIRECTORY}/\n`, "utf8");
  }
}

async function listMarkdownFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = prefix === "" ? root : join(root, prefix);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const relativePath = prefix === "" ? name : `${prefix}/${name}`;
    const information = await stat(join(directory, name));
    if (information.isDirectory()) {
      found.push(...await listMarkdownFiles(root, relativePath));
      continue;
    }
    if (!information.isFile() || !name.toLowerCase().endsWith(".md")) continue;
    found.push(relativePath);
    if (found.length > MAX_FILES) throw new Error(`个人数据库文件数量超过 ${MAX_FILES}`);
  }
  return found;
}
