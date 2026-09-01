import type { ProviderModelSelection } from "./types.js";

export type ModelCapabilitySource =
  | "user"
  | "provider"
  | "builtin"
  | "unknown";

export type ReasoningEffortCapabilities =
  | {
      readonly status: "known";
      readonly source: Exclude<ModelCapabilitySource, "unknown">;
      readonly efforts: readonly string[];
      readonly defaultEffort?: string;
    }
  | {
      readonly status: "unsupported";
      readonly source: Exclude<ModelCapabilitySource, "unknown">;
    }
  | { readonly status: "unknown"; readonly source: "unknown" };

export interface ModelCapabilities {
  readonly reasoningEffort: ReasoningEffortCapabilities;
}

export interface ModelCapabilityDiscovery {
  discoverReasoningEffort(
    selection: ProviderModelSelection,
  ): Promise<ReasoningEffortCapabilities | undefined>;
}

export interface ModelCapabilityResolverOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly discoveries?: readonly ModelCapabilityDiscovery[];
}

/** Resolves model metadata in explicit, provider, built-in, then unknown order. */
export class ModelCapabilityResolver {
  private readonly discoveries: readonly ModelCapabilityDiscovery[];

  constructor(options: ModelCapabilityResolverOptions = {}) {
    this.discoveries = options.discoveries ?? [
      new CpaCodexCapabilityDiscovery(options.fetch ?? globalThis.fetch),
    ];
  }

  async resolve(selection: ProviderModelSelection): Promise<ModelCapabilities> {
    const explicit = explicitReasoningEffort(selection);
    if (explicit !== undefined) return { reasoningEffort: explicit };

    for (const discovery of this.discoveries) {
      const discovered = await discovery.discoverReasoningEffort(selection);
      if (discovered !== undefined) return { reasoningEffort: discovered };
    }

    return {
      reasoningEffort: builtinReasoningEffort(selection) ?? {
        status: "unknown",
        source: "unknown",
      },
    };
  }
}

export function createModelCapabilityResolver(
  options: ModelCapabilityResolverOptions = {},
): ModelCapabilityResolver {
  return new ModelCapabilityResolver(options);
}

interface CatalogReasoningEffort {
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}

const BUILTIN_REASONING_EFFORTS = new Map<string, CatalogReasoningEffort>([
  // https://developers.openai.com/api/docs/models/gpt
  ...["openai-responses", "openai-chat-completions"].flatMap((adapter) =>
    ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
      (model) => [
        catalogKey(adapter, model),
        {
          efforts: ["none", "low", "medium", "high", "xhigh", "max"],
          defaultEffort: "medium",
        },
      ] as const,
    )
  ),
  // https://api-docs.deepseek.com/api/create-chat-completion/
  ...[
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
  ].map((model) => [
    catalogKey("deepseek-chat", model),
    { efforts: ["low", "high", "max"], defaultEffort: "high" },
  ] as const),
]);

function explicitReasoningEffort(
  selection: ProviderModelSelection,
): ReasoningEffortCapabilities | undefined {
  const override = selection.capabilities?.reasoning;
  if (override === undefined) return undefined;
  if (override === false || override.efforts.length === 0) {
    return { status: "unsupported", source: "user" };
  }
  return {
    status: "known",
    source: "user",
    efforts: [...override.efforts],
    ...(override.defaultEffort === undefined
      ? {}
      : { defaultEffort: override.defaultEffort }),
  };
}

function builtinReasoningEffort(
  selection: ProviderModelSelection,
): ReasoningEffortCapabilities | undefined {
  const entry = BUILTIN_REASONING_EFFORTS.get(
    catalogKey(selection.adapter, selection.model),
  );
  if (entry === undefined) return undefined;
  return {
    status: "known",
    source: "builtin",
    efforts: [...entry.efforts],
    ...(entry.defaultEffort === undefined
      ? {}
      : { defaultEffort: entry.defaultEffort }),
  };
}

function catalogKey(adapter: string, model: string): string {
  return `${adapter}\u0000${model}`;
}

/** Discovers the enriched Codex catalog exposed by current CLIProxyAPI builds. */
class CpaCodexCapabilityDiscovery implements ModelCapabilityDiscovery {
  private readonly catalogs = new Map<
    string,
    Promise<ReadonlyMap<string, CatalogReasoningEffort> | undefined>
  >();

  constructor(private readonly fetchImplementation: typeof globalThis.fetch) {}

  async discoverReasoningEffort(
    selection: ProviderModelSelection,
  ): Promise<ReasoningEffortCapabilities | undefined> {
    if (
      selection.adapter !== "openai-responses" &&
      selection.adapter !== "openai-chat-completions"
    ) {
      return undefined;
    }
    const baseURL = selection.providerConfig.baseURL;
    if (baseURL === undefined) return undefined;

    const cacheKey = `${selection.provider}\u0000${baseURL}`;
    let catalog = this.catalogs.get(cacheKey);
    if (catalog === undefined) {
      catalog = this.fetchCatalog(selection, baseURL);
      this.catalogs.set(cacheKey, catalog);
    }
    const entry = (await catalog)?.get(selection.model);
    if (entry === undefined) return undefined;
    return {
      status: "known",
      source: "provider",
      efforts: [...entry.efforts],
      ...(entry.defaultEffort === undefined
        ? {}
        : { defaultEffort: entry.defaultEffort }),
    };
  }

  private async fetchCatalog(
    selection: ProviderModelSelection,
    baseURL: string,
  ): Promise<ReadonlyMap<string, CatalogReasoningEffort> | undefined> {
    const url = `${baseURL.replace(/\/+$/u, "")}/models?client_version=may`;
    const apiKey = selection.providerConfig.apiKey;
    try {
      const response = await this.fetchImplementation(url, {
        ...(apiKey === undefined || apiKey.trim() === ""
          ? {}
          : { headers: { Authorization: `Bearer ${apiKey}` } }),
      });
      if (!response.ok) return undefined;
      return parseCpaCodexCatalog(await response.json());
    } catch {
      return undefined;
    }
  }
}

function parseCpaCodexCatalog(
  value: unknown,
): ReadonlyMap<string, CatalogReasoningEffort> | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
  const result = new Map<string, CatalogReasoningEffort>();
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.slug !== "string") continue;
    if (!Array.isArray(model.supported_reasoning_levels)) continue;
    const efforts = model.supported_reasoning_levels.flatMap((level) => {
      if (typeof level === "string") return level.trim() === "" ? [] : [level];
      if (!isRecord(level) || typeof level.effort !== "string") return [];
      return level.effort.trim() === "" ? [] : [level.effort];
    });
    const uniqueEfforts = [...new Set(efforts)];
    if (uniqueEfforts.length === 0) continue;
    const candidateDefault = typeof model.default_reasoning_level === "string"
      ? model.default_reasoning_level
      : undefined;
    result.set(model.slug, {
      efforts: uniqueEfforts,
      ...(candidateDefault !== undefined && uniqueEfforts.includes(candidateDefault)
        ? { defaultEffort: candidateDefault }
        : {}),
    });
  }
  return result.size === 0 ? undefined : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
