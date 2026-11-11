import { ToolUsageError, type JsonSchema, type Tool, type Usage } from "@sortedyuan/may/core";

/** @experimental */
export interface KimiFormulaToolsOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly uri: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** @experimental */
export class KimiFormulaError extends ToolUsageError {
  override readonly code = "KIMI_FORMULA_ERROR";
  constructor(
    message: string,
    readonly status?: string | number,
    readonly fiberId?: string,
    options?: ErrorOptions & { readonly usage?: Usage },
  ) {
    super(message, options?.usage ?? {}, options);
    this.name = "KimiFormulaError";
  }
}

/** @experimental */
export class KimiFormulaRawInputError extends Error {
  readonly code = "KIMI_FORMULA_RAW_INPUT_REQUIRED";
  constructor() {
    super("Kimi Formula requires the original tool argument string in context.rawInput");
    this.name = "KimiFormulaRawInputError";
  }
}

interface FormulaOutput {
  readonly content: string;
  readonly usage: Usage;
}

/** @experimental */
export async function createKimiFormulaTools(options: KimiFormulaToolsOptions): Promise<Tool[]> {
  if (typeof options.apiKey !== "string" || options.apiKey.trim() === "")
    throw new TypeError("apiKey must not be empty");
  if (
    typeof options.uri !== "string" ||
    options.uri.trim() === "" ||
    options.uri.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError("uri must be a Formula URI");
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("timeoutMs must be a positive safe integer");
  const base = new URL(options.baseURL ?? "https://api.moonshot.ai/v1");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError("baseURL must be an HTTP URL without credentials, query or fragment");
  }
  const endpoint = `${base.href.replace(/\/+$/u, "")}/formulas/${options.uri.split("/").map(encodeURIComponent).join("/")}`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  const response = await fetchImplementation(`${endpoint}/tools`, { headers, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new KimiFormulaError("Kimi Formula tools request failed", response.status);
  const definitions: unknown = record(await response.json(), "tools response").tools;
  if (!Array.isArray(definitions)) throw new KimiFormulaError("Kimi Formula tools must be an array");
  const names = new Set<string>();
  return definitions.map((definition): Tool<unknown, FormulaOutput> => {
    const item = record(definition, "tool definition");
    const fn = record(item.function, "tool function");
    if (
      item.type !== "function" ||
      typeof fn.name !== "string" ||
      fn.name.trim() === "" ||
      typeof fn.description !== "string"
    ) {
      throw new KimiFormulaError("Invalid Kimi Formula function definition");
    }
    if (names.has(fn.name)) throw new KimiFormulaError("Duplicate Kimi Formula function name");
    names.add(fn.name);
    const name = fn.name;
    const schema = record(fn.parameters, "function parameters") as JsonSchema;
    return {
      name,
      description: fn.description,
      inputSchema: schema,
      permissionVersion: `kimi-formula:${options.uri}`,
      workspaceEffect: "read",
      usage(output) {
        return output.usage;
      },
      async execute(_input, context) {
        if (typeof context.rawInput !== "string") throw new KimiFormulaRawInputError();
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
        let fiber: Record<string, unknown>;
        try {
          const result = await fetchImplementation(`${endpoint}/fibers`, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({ name, arguments: context.rawInput }),
          });
          if (!result.ok) throw new KimiFormulaError("Kimi Formula execution request failed", result.status);
          fiber = record(await result.json(), "fiber");
        } catch (cause) {
          if (cause instanceof KimiFormulaError) throw cause;
          throw new KimiFormulaError("Kimi Formula execution outcome is unknown", undefined, undefined, {
            cause,
            usage: { completeness: { status: "partial", reason: "host-search-outcome-unknown" } },
          });
        }
        const id = typeof fiber.id === "string" ? fiber.id : undefined;
        if (fiber.status !== "succeeded") {
          throw new KimiFormulaError("Kimi Formula execution did not succeed", String(fiber.status), id);
        }
        const output = record(fiber.context, "fiber.context");
        const content = output.output ?? output.encrypted_output;
        if (typeof content !== "string" || content === "") {
          throw new KimiFormulaError("Kimi Formula returned no output", "succeeded", id);
        }
        return { content, usage: { items: [{ id: "web-search", quantity: 1, unit: "requests", includedIn: "none" }] } };
      },
      resultContent(output) {
        return [{ type: "text", text: output.content }];
      },
    };
  });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new KimiFormulaError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
