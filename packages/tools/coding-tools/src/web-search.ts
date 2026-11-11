import { defineTool, type Tool, type Usage } from "@sortedyuan/may/core";
import { z } from "zod";
import { requirePositiveIntegerOption } from "./input.js";

/** @experimental */
export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly siteName?: string;
  readonly published?: string;
}

/** @experimental */
export interface WebSearchBackend {
  readonly id: string;
  search(
    query: { readonly query: string; readonly count: number },
    signal: AbortSignal,
    options?: { readonly maxResponseBytes: number },
  ): Promise<{ readonly items: readonly WebSearchResultItem[]; readonly usage: Usage }>;
}

/** @experimental */
export interface WebSearchToolOptions {
  readonly backend: WebSearchBackend;
  readonly maxResults?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxSummaryChars?: number;
}

/** @experimental */
export interface WebSearchOutput {
  readonly items: readonly WebSearchResultItem[];
  readonly usage: Usage;
}

/** @experimental */
export class WebSearchToolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`web_search: ${message}`);
    this.name = "WebSearchToolError";
  }
}

const querySchema = z.string().refine((value) => value.trim().length > 0 && [...value].length <= 128, {
  message: "query must contain 1 to 128 Unicode characters and cannot be whitespace",
});
const requestSchema = z.object({ query: querySchema, count: z.number().int().min(1).max(50) }).strict();

/** @experimental */
export function createWebSearchTool(
  options: WebSearchToolOptions,
): Tool<{ query: string; count?: number | undefined }, WebSearchOutput> {
  const maxResults = requirePositiveIntegerOption(options.maxResults, 10, "maxResults");
  if (maxResults > 50) throw new RangeError("maxResults must not exceed 50");
  const timeoutMs = requirePositiveIntegerOption(options.timeoutMs, 30_000, "timeoutMs");
  const maxResponseBytes = requirePositiveIntegerOption(options.maxResponseBytes, 1_048_576, "maxResponseBytes");
  const maxSummaryChars = requirePositiveIntegerOption(options.maxSummaryChars, 2000, "maxSummaryChars");
  const schema = z.object({ query: querySchema, count: z.number().int().min(1).max(maxResults).optional() }).strict();
  return defineTool({
    name: "web_search",
    description: "Search the web. DeepSeek queries support site:, -site:, after:, before:, and lang: operators.",
    workspaceEffect: "read",
    permissionVersion: options.backend.id,
    schema,
    usage(output) {
      return output.usage;
    },
    async execute(input, context) {
      const parsed = schema.parse(input);
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(new WebSearchToolError("timeoutMs exceeded")), timeoutMs);
      try {
        signal.throwIfAborted();
        const result = await options.backend.search(
          { query: parsed.query, count: parsed.count ?? maxResults },
          signal,
          {
            maxResponseBytes,
          },
        );
        signal.throwIfAborted();
        return {
          items: result.items.slice(0, parsed.count ?? maxResults).map((item) => ({
            ...item,
            summary: [...item.summary].slice(0, maxSummaryChars).join(""),
          })),
          usage: result.usage,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

interface BackendOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const optionalText = z.string().nullish();
const deepSeekResponse = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), summary: z.string(), site_name: optionalText, date: optionalText }),
  ),
});
const zhipuResponse = z.object({
  search_result: z.array(
    z.object({
      title: z.string(),
      link: z.string(),
      content: z.string(),
      media: optionalText,
      publish_date: optionalText,
    }),
  ),
});

/** @experimental */
export function createDeepSeekSearchBackend(options: BackendOptions): WebSearchBackend {
  const url = new URL("/v1/tools/search", options.baseURL ?? "https://api.deepseek.com");
  validateBackend(options, url);
  return {
    id: "deepseek",
    async search(query, signal, limits) {
      const data = deepSeekResponse.parse(
        await post(options, url, requestSchema.parse(query), signal, limits?.maxResponseBytes),
      );
      const items = data.results.map((item) => ({
        title: item.title,
        url: item.url,
        summary: item.summary,
        ...(item.site_name == null ? {} : { siteName: item.site_name }),
        ...(item.date == null ? {} : { published: item.date }),
      }));
      return { items, usage: searchUsage("deepseek", items.length > 0 ? 1 : 0) };
    },
  };
}

/** @experimental */
export function createZhipuSearchBackend(
  options: BackendOptions & {
    readonly searchEngine: "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";
  },
): WebSearchBackend {
  const engine = z
    .enum(["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"])
    .parse(options.searchEngine);
  const url = new URL(`${(options.baseURL ?? "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/u, "")}/web_search`);
  validateBackend(options, url);
  const id = `zhipu:${engine}`;
  return {
    id,
    async search(query, signal, limits) {
      const parsed = requestSchema.parse(query);
      const data = zhipuResponse.parse(
        await post(
          options,
          url,
          {
            search_query: parsed.query,
            search_engine: engine,
            count: parsed.count,
          },
          signal,
          limits?.maxResponseBytes,
        ),
      );
      return {
        items: data.search_result.map((item) => ({
          title: item.title,
          url: item.link,
          summary: item.content,
          ...(item.media == null ? {} : { siteName: item.media }),
          ...(item.publish_date == null ? {} : { published: item.publish_date }),
        })),
        usage: searchUsage(id, 1),
      };
    },
  };
}

function searchUsage(id: string, quantity: number): Usage {
  return {
    items: [{ id: `web-search:${id}`, quantity, unit: "requests", includedIn: "none" }],
    completeness: { status: "complete" },
  };
}

function validateBackend(options: BackendOptions, url: URL): void {
  if (options.apiKey.trim() === "") throw new TypeError("apiKey must be non-empty");
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
    throw new TypeError("baseURL must use HTTP or HTTPS without URL credentials");
  }
}

async function post(
  options: BackendOptions,
  url: URL,
  body: unknown,
  signal: AbortSignal,
  maxBytes = 1_048_576,
): Promise<unknown> {
  requirePositiveIntegerOption(maxBytes, 1_048_576, "maxResponseBytes");
  signal.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    signal,
    redirect: "error",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader !== undefined) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new WebSearchToolError("maxResponseBytes exceeded", response.status);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  const text = Buffer.concat(chunks).toString("utf8");
  if (response.status !== 200) {
    let code: string | undefined;
    if (response.headers.get("content-type")?.includes("json") || text.trim().startsWith("{")) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new WebSearchToolError(`HTTP ${response.status}: invalid JSON error response`, response.status);
      }
      const parsed = z
        .object({ error: z.object({ code: z.union([z.string(), z.number()]).optional() }).optional() })
        .safeParse(data);
      if (parsed.success && parsed.data.error?.code !== undefined) code = String(parsed.data.error.code);
    }
    throw new WebSearchToolError(
      `HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
      response.status,
      code,
    );
  }
  return JSON.parse(text);
}
