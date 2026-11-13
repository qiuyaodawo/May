import type { ModelCapabilityDiscovery, ModelCapabilityFields, ReasoningEffortCapabilities } from "./capabilities.js";
import { isRecord, known } from "./capability-values.js";
import type { ProviderModelSelection } from "./types.js";

interface ModelEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Selects the entry describing the requested model from the parsed response body. */
  readonly entry: (body: Record<string, unknown>) => unknown;
}
const BEARER_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-chat-completions": "https://api.openai.com/v1",
  "deepseek-chat": "https://api.deepseek.com",
  "kimi-chat": "https://api.moonshot.ai/v1",
  "zhipu-chat": "https://open.bigmodel.cn/api/paas/v4",
};
function trimBaseURL(value: string): string {
  return value.replace(/\/+$/u, "");
}
/** Finds `models[]` entries by `slug` (CLIProxyAPI's Codex catalog) and `data[]` entries by `id`. */
function listEntry(model: string): (body: Record<string, unknown>) => unknown {
  return (body) =>
    Array.isArray(body.models)
      ? body.models.find((entry) => isRecord(entry) && entry.slug === model)
      : Array.isArray(body.data)
        ? body.data.find((entry) => isRecord(entry) && entry.id === model)
        : undefined;
}
function modelEndpoint(selection: ProviderModelSelection): ModelEndpoint | undefined {
  const { adapter, model, providerConfig, options } = selection;
  const apiKey =
    providerConfig.apiKey === undefined || providerConfig.apiKey.trim() === "" ? undefined : providerConfig.apiKey;
  const bearer = BEARER_DEFAULT_BASE_URLS[adapter];
  if (bearer !== undefined) {
    return {
      url: `${trimBaseURL(providerConfig.baseURL ?? bearer)}/models?client_version=may`,
      headers: apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` },
      entry: listEntry(model),
    };
  }
  if (adapter === "anthropic-messages") {
    return {
      url: `${trimBaseURL(providerConfig.baseURL ?? "https://api.anthropic.com")}/v1/models?limit=1000`,
      headers: {
        "anthropic-version": typeof options.apiVersion === "string" ? options.apiVersion : "2023-06-01",
        ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
      },
      entry: listEntry(model),
    };
  }
  if (adapter === "google-gemini") {
    return {
      url: `${trimBaseURL(providerConfig.baseURL ?? "https://generativelanguage.googleapis.com/v1beta")}/models/${encodeURIComponent(model)}`,
      headers: apiKey === undefined ? {} : { "x-goog-api-key": apiKey },
      entry: (body) => body,
    };
  }
  return undefined;
}
function effortNames(levels: readonly unknown[]): string[] {
  return [
    ...new Set(
      levels.flatMap((level) => {
        const effort = typeof level === "string" ? level : isRecord(level) ? level.effort : undefined;
        return typeof effort === "string" && effort.trim() !== "" ? [effort] : [];
      }),
    ),
  ];
}
/** Reads `supported_reasoning_levels`, `reasoning_levels`, `effort.supported_levels` or Gemini's `thinking: false`. */
function entryReasoningEffort(entry: Record<string, unknown>): ReasoningEffortCapabilities | undefined {
  const effort = isRecord(entry.effort) ? entry.effort : undefined;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels
    : Array.isArray(entry.reasoning_levels)
      ? entry.reasoning_levels
      : Array.isArray(effort?.supported_levels)
        ? effort.supported_levels
        : undefined;
  if (levels === undefined) return entry.thinking === false ? { status: "unsupported", source: "provider" } : undefined;
  const efforts = effortNames(levels);
  if (efforts.length === 0) return undefined;
  const defaultEffort = entry.default_reasoning_level ?? effort?.default_level;
  return {
    status: "known",
    source: "provider",
    efforts,
    ...(typeof defaultEffort === "string" && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };
}
/** Reads reasoning levels from the model endpoint of every built-in adapter. */
export class ModelListCapabilityDiscovery implements ModelCapabilityDiscovery {
  readonly name = "model-list";
  private readonly entries = new WeakMap<ProviderModelSelection, unknown>();
  constructor(private readonly fetchImplementation: typeof globalThis.fetch) {}
  async discoverCapabilities(selection: ProviderModelSelection): Promise<ModelCapabilityFields | undefined> {
    if (selection.adapter !== "anthropic-messages") return undefined;
    const endpoint = modelEndpoint(selection)!;
    const response = await this.fetchImplementation(endpoint.url, {
      signal: AbortSignal.timeout(10_000),
      headers: endpoint.headers,
    });
    if (response.status === 404) {
      this.entries.set(selection, undefined);
      return undefined;
    }
    if (!response.ok) throw new Error("Capability catalog request failed");
    const body: unknown = await response.json();
    const entry = isRecord(body) ? endpoint.entry(body) : undefined;
    this.entries.set(selection, entry);
    if (
      !isRecord(entry) ||
      !isRecord(entry.capabilities) ||
      !isRecord(entry.capabilities.server_tools) ||
      !isRecord(entry.capabilities.server_tools.web_search)
    )
      return undefined;
    const supported = entry.capabilities.server_tools.web_search.supported;
    return typeof supported === "boolean" ? { "serverTools.webSearch": known(supported, "provider") } : undefined;
  }
  async discoverReasoningEffort(selection: ProviderModelSelection): Promise<ReasoningEffortCapabilities | undefined> {
    if (this.entries.has(selection)) {
      const entry = this.entries.get(selection);
      this.entries.delete(selection);
      return isRecord(entry) ? entryReasoningEffort(entry) : undefined;
    }
    const endpoint = modelEndpoint(selection);
    if (endpoint === undefined) return undefined;
    const response = await this.fetchImplementation(endpoint.url, {
      signal: AbortSignal.timeout(10_000),
      headers: endpoint.headers,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("Capability catalog request failed");
    const value: unknown = await response.json();
    if (!isRecord(value)) return undefined;
    const entry = endpoint.entry(value);
    return isRecord(entry) ? entryReasoningEffort(entry) : undefined;
  }
}
