import { createHash } from "node:crypto";
import {
  MODEL_CAPABILITY_KEYS,
  parseMayConfig,
  type ModelCapabilityDeclaration,
  type ModelCapabilitiesOverride,
  type ModelCapabilityKey,
} from "@sortedyuan/may/config";
import { omitUndefined, type ModelRequest } from "@sortedyuan/may/core";
import type { ProviderModelSelection } from "./types.js";
import { selectionWebSearch } from "./web-search.js";

export { MODEL_CAPABILITY_KEYS };
export type { ModelCapabilityKey, ModelCapabilityDeclaration };
/** @experimental */
export type ModelCapabilitySource = "user" | "provider" | "builtin" | "adapter" | "unknown";
/** @experimental */
export type ModelCapabilityLayer = "model" | "adapter" | "connection";
/** @experimental */
export type CapabilityValue<T = ModelCapabilityDeclaration> =
  | { readonly status: "known"; readonly source: Exclude<ModelCapabilitySource, "unknown">; readonly value: T }
  | { readonly status: "unsupported"; readonly source: Exclude<ModelCapabilitySource, "unknown"> }
  | { readonly status: "unknown"; readonly source: "unknown" };
/** @experimental */
export type ReasoningEffortCapabilities =
  | {
      readonly status: "known";
      readonly source: Exclude<ModelCapabilitySource, "unknown">;
      readonly efforts: readonly string[];
      readonly defaultEffort?: string;
    }
  | { readonly status: "unsupported"; readonly source: Exclude<ModelCapabilitySource, "unknown"> }
  | { readonly status: "unknown"; readonly source: "unknown" };
/** @experimental */
export type ModelCapabilityFields = Readonly<Partial<Record<ModelCapabilityKey, CapabilityValue>>>;
/** @experimental */
export interface ModelCapabilityDiagnostic {
  readonly discovery: string;
  readonly code: "DISCOVERY_FAILED";
  readonly observedAt: number;
}
/** @experimental */
export interface ModelCapabilities {
  readonly reasoningEffort: ReasoningEffortCapabilities;
  readonly fields?: ModelCapabilityFields;
  readonly layers?: Readonly<Record<ModelCapabilityLayer, ModelCapabilityFields>>;
  readonly version?: string;
  readonly observedAt?: number;
  readonly expiresAt?: number;
  readonly diagnostics?: readonly ModelCapabilityDiagnostic[];
}
/** @experimental */
export interface ModelCapabilityDiscovery {
  readonly name?: string;
  discoverReasoningEffort?(selection: ProviderModelSelection): Promise<ReasoningEffortCapabilities | undefined>;
  discoverCapabilities?(
    selection: ProviderModelSelection,
    fields?: readonly ModelCapabilityKey[],
  ): Promise<ModelCapabilityFields | undefined>;
}
/** @experimental */
export interface ModelCapabilityResolverOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly discoveries?: readonly ModelCapabilityDiscovery[];
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly maxVerificationRecords?: number;
  readonly adapterCapabilities?: Readonly<Record<string, ModelCapabilityFields>>;
}
/** @experimental */
export interface ResolveModelCapabilitiesOptions {
  readonly fields?: readonly ModelCapabilityKey[];
  readonly refresh?: boolean;
}
/** @experimental */
export interface ModelCapabilityVerificationRecord {
  readonly model: string;
  readonly adapter: string;
  readonly connectionId: string;
  readonly capability: ModelCapabilityKey;
  readonly observedAt: number;
  readonly success: boolean;
  readonly evidence: "request-accepted" | "response-validated" | "failed";
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}
interface DiscoveryResult {
  readonly fields: ModelCapabilityFields;
  readonly reasoningEffort?: ReasoningEffortCapabilities;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly diagnostics: readonly ModelCapabilityDiagnostic[];
}
/** @experimental */
export class ModelCapabilityResolver {
  private readonly discoveries: readonly ModelCapabilityDiscovery[];
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly maxRecords: number;
  private readonly adapters: Readonly<Record<string, ModelCapabilityFields>>;
  private readonly cache = new Map<string, DiscoveryResult>();
  private readonly pending = new Map<string, Promise<DiscoveryResult>>();
  private readonly records: ModelCapabilityVerificationRecord[] = [];

  constructor(options: ModelCapabilityResolverOptions = {}) {
    this.discoveries = options.discoveries ?? [new ModelListCapabilityDiscovery(options.fetch ?? globalThis.fetch)];
    this.ttl = positive(options.cacheTtlMs ?? 300_000, "cacheTtlMs");
    this.maxEntries = positive(options.maxCacheEntries ?? 128, "maxCacheEntries");
    this.maxRecords = positive(options.maxVerificationRecords ?? 256, "maxVerificationRecords");
    this.adapters = structuredClone(options.adapterCapabilities ?? {});
    for (const fields of Object.values(this.adapters)) assertCapabilityFields(fields);
  }
  async resolve(
    selection: ProviderModelSelection,
    options: ResolveModelCapabilitiesOptions = {},
  ): Promise<ModelCapabilities> {
    const requested = options.fields ?? MODEL_CAPABILITY_KEYS;
    for (const field of requested)
      if (!MODEL_CAPABILITY_KEYS.includes(field)) throw new TypeError(`Unknown capability field ${field}`);
    const explicit = declaredFields(selection.capabilities, "user");
    assertCapabilityFields(explicit);
    const explicitReasoning = declaredReasoning(selection.capabilities, "user");
    if (explicitReasoning !== undefined) assertReasoningCapabilities(explicitReasoning);
    const discovered = await this.discover(
      selection,
      options.refresh === true,
      explicitReasoning !== undefined,
      requested,
    );
    const model: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    const adapter = this.adapters[selection.adapter] ?? builtinAdapterCapabilities(selection.adapter);
    const connection = declaredFields(selection.providerConfig.capabilities, "user");
    assertCapabilityFields(connection);
    const connectionReasoning = declaredReasoning(selection.providerConfig.capabilities, "user");
    if (connectionReasoning !== undefined) assertReasoningCapabilities(connectionReasoning);
    const effective: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    for (const field of requested) {
      const builtin =
        selection.adapter === "openai-chat-completions" &&
        selection.model === "gpt-5-search-api" &&
        field === "serverTools.alwaysSearches"
          ? known(true, "builtin")
          : undefined;
      const value =
        explicit[field] ?? declaredLimit(selection, field) ?? discovered.fields[field] ?? builtin ?? UNKNOWN;
      model[field] = value;
      effective[field] = intersectCapability(field, [value, adapter[field], connection[field]]);
    }
    const reasoning = explicitReasoning ?? discovered.reasoningEffort ?? builtinReasoningEffort(selection) ?? UNKNOWN;
    const reasoningEffort = intersectReasoning(reasoning, connectionReasoning);
    const layers = { model, adapter, connection };
    return structuredClone({
      reasoningEffort,
      fields: effective,
      layers,
      version: digest({ reasoningEffort, fields: effective, layers }),
      observedAt: discovered.observedAt,
      expiresAt: discovered.expiresAt,
      diagnostics: discovered.diagnostics,
    });
  }
  invalidate(selection?: ProviderModelSelection): void {
    if (selection === undefined) {
      this.cache.clear();
      this.pending.clear();
      return;
    }
    const prefix = connectionIdentity(selection);
    for (const key of [...this.cache.keys(), ...this.pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.cache.delete(key);
      this.pending.delete(key);
    }
  }
  verificationRecords(selection?: ProviderModelSelection): readonly ModelCapabilityVerificationRecord[] {
    const connectionId = selection === undefined ? undefined : connectionIdentity(selection);
    return this.records
      .filter(
        (record) =>
          connectionId === undefined || (record.connectionId === connectionId && record.model === selection?.model),
      )
      .map((record) => ({ ...record, parameters: { ...record.parameters } }));
  }
  recordVerification(
    selection: ProviderModelSelection,
    request: ModelRequest,
    success: boolean,
    responseValidated = false,
    additionalCapabilities: readonly ModelCapabilityKey[] = [],
  ): void {
    const used = new Set<ModelCapabilityKey>(additionalCapabilities);
    for (const message of request.messages)
      for (const part of message.content) {
        if (part.type === "text" || part.type === "json") used.add("input.text");
        if (["image", "audio", "file", "resource"].includes(part.type))
          used.add(`input.${part.type}` as ModelCapabilityKey);
      }
    if (request.tools.length > 0) used.add("tools");
    const search = selectionWebSearch(selection);
    if (
      (search !== undefined && search !== false) ||
      (selection.adapter === "openai-chat-completions" && selection.model === "gpt-5-search-api")
    ) {
      used.add("serverTools.webSearch");
      if (request.tools.length > 0) used.add("serverTools.webSearchWithFunctions");
    }
    if (request.responseFormat !== undefined)
      used.add(request.responseFormat.type === "json" ? "structuredOutput.json" : "structuredOutput.jsonSchema");
    const thinking = selection.options.thinking;
    const activeThinking =
      thinking !== undefined && thinking !== "disabled" && !(isRecord(thinking) && thinking.type === "disabled");
    if (
      selection.options.reasoningEffort !== undefined ||
      activeThinking ||
      selection.options.reasoningSummary !== undefined
    )
      used.add("reasoning.modes");
    const parameters: Record<string, string | number | boolean> = {};
    if (typeof selection.options.reasoningEffort === "string")
      parameters.reasoningEffort = selection.options.reasoningEffort;
    for (const key of ["maxTokens", "maxOutputTokens"] as const)
      if (typeof selection.options[key] === "number") parameters[key] = selection.options[key];
    if (
      parameters.maxTokens === undefined &&
      parameters.maxOutputTokens === undefined &&
      selection.limits?.maxOutputTokens !== undefined
    ) {
      parameters[
        ["deepseek-chat", "kimi-chat", "zhipu-chat", "anthropic-messages"].includes(selection.adapter)
          ? "maxTokens"
          : "maxOutputTokens"
      ] = selection.limits.maxOutputTokens;
    }
    if (typeof selection.options.reasoningSummary === "string")
      parameters.reasoningSummary = selection.options.reasoningSummary;
    if (typeof thinking === "string") parameters.thinkingType = thinking;
    else if (isRecord(thinking)) {
      if (typeof thinking.type === "string") parameters.thinkingType = thinking.type;
      if (typeof thinking.budgetTokens === "number") parameters.thinkingBudgetTokens = thinking.budgetTokens;
    }
    if (request.responseFormat?.type === "jsonSchema") {
      parameters.schemaVersion = digest(request.responseFormat.schema);
      parameters.strict = request.responseFormat.strict ?? false;
    }
    for (const capability of used) {
      const observed: Record<string, string | number | boolean> = { ...parameters };
      const parts = request.messages
        .flatMap((message) => message.content)
        .filter((part) =>
          capability === "input.text"
            ? part.type === "text" || part.type === "json"
            : capability === `input.${part.type}`,
        );
      if (capability.startsWith("input.")) observed.count = parts.length;
      const media = parts.filter((part) => part.type === "image" || part.type === "audio" || part.type === "file");
      if (media.length > 0) {
        for (const source of ["url", "base64", "file"] as const)
          observed[`${source}Sources`] = media.filter((part) => part.source.type === source).length;
        const base64 = media.flatMap((part) => (part.source.type === "base64" ? [part.source] : []));
        const bytes = base64.map((source) => Buffer.byteLength(source.data, "base64"));
        observed.knownBytesCount = bytes.length;
        if (bytes.length > 0) {
          observed.minObservedBytes = Math.min(...bytes);
          observed.maxObservedBytes = Math.max(...bytes);
        }
        observed.mediaTypesVersion = digest([...new Set(base64.map((source) => source.mediaType))].sort());
      }
      if (capability === "tools") {
        observed.definitions = request.tools.length;
        observed.definitionsVersion = digest(request.tools);
      }
      const evidence = !success
        ? "failed"
        : capability.startsWith("structuredOutput.") && responseValidated
          ? "response-validated"
          : "request-accepted";
      this.records.push({
        model: selection.model,
        adapter: selection.adapter,
        connectionId: connectionIdentity(selection),
        capability,
        observedAt: Date.now(),
        success,
        evidence,
        parameters: observed,
      });
    }
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
  }
  private async discover(
    selection: ProviderModelSelection,
    refresh: boolean,
    skipReasoning: boolean,
    fields: readonly ModelCapabilityKey[],
  ): Promise<DiscoveryResult> {
    const key = `${connectionIdentity(selection)}:${digest({ model: selection.model, fields: [...fields].sort(), skipReasoning })}`;
    if (refresh) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.cache.delete(key);
    const active = this.pending.get(key);
    if (active !== undefined) return active;
    if (this.pending.size >= this.maxEntries) throw new RangeError("Capability discovery concurrency limit exceeded");
    const operation = this.query(selection, skipReasoning, fields);
    this.pending.set(key, operation);
    try {
      const result = await operation;
      if (this.pending.get(key) === operation && result.diagnostics.length === 0) {
        this.cache.set(key, result);
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      return result;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }
  private async query(
    selection: ProviderModelSelection,
    skipReasoning: boolean,
    requested: readonly ModelCapabilityKey[],
  ): Promise<DiscoveryResult> {
    const fields: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    let reasoningEffort: ReasoningEffortCapabilities | undefined;
    const diagnostics: ModelCapabilityDiagnostic[] = [];
    for (const [index, discovery] of this.discoveries.entries()) {
      let found: ModelCapabilityFields | undefined;
      let foundReasoning: ReasoningEffortCapabilities | undefined;
      try {
        found = await discovery.discoverCapabilities?.(selection, requested);
        if (!skipReasoning && reasoningEffort === undefined)
          foundReasoning = await discovery.discoverReasoningEffort?.(selection);
      } catch {
        diagnostics.push({
          discovery: discovery.name ?? `discovery-${index + 1}`,
          code: "DISCOVERY_FAILED",
          observedAt: Date.now(),
        });
        continue;
      }
      if (found !== undefined) assertCapabilityFields(found);
      if (foundReasoning !== undefined) assertReasoningCapabilities(foundReasoning);
      if (found !== undefined)
        for (const field of requested)
          if (fields[field] === undefined && found[field] !== undefined) fields[field] = found[field];
      reasoningEffort ??= foundReasoning;
    }
    const observedAt = Date.now();
    return omitUndefined({ fields, reasoningEffort, observedAt, expiresAt: observedAt + this.ttl, diagnostics });
  }
}
/** @experimental */
export function createModelCapabilityResolver(options: ModelCapabilityResolverOptions = {}): ModelCapabilityResolver {
  return new ModelCapabilityResolver(options);
}
/** @experimental */
export function connectionIdentity(selection: ProviderModelSelection): string {
  return digest({ provider: selection.provider, adapter: selection.adapter, config: selection.providerConfig });
}
const UNKNOWN = { status: "unknown", source: "unknown" } as const;
function known(value: ModelCapabilityDeclaration, source: Exclude<ModelCapabilitySource, "unknown">): CapabilityValue {
  return value === false ? { status: "unsupported", source } : { status: "known", source, value };
}
function declaredFields(
  overrides: ModelCapabilitiesOverride | undefined,
  source: Exclude<ModelCapabilitySource, "unknown">,
): ModelCapabilityFields {
  return Object.fromEntries(
    Object.entries(overrides?.fields ?? {}).map(([field, value]) => [field, known(value, source)]),
  );
}
function declaredLimit(selection: ProviderModelSelection, field: ModelCapabilityKey): CapabilityValue | undefined {
  if (field !== "contextWindowTokens" && field !== "maxOutputTokens") return undefined;
  const value = selection.limits?.[field];
  return value === undefined ? undefined : known(value, "user");
}
function declaredReasoning(
  overrides: ModelCapabilitiesOverride | undefined,
  source: Exclude<ModelCapabilitySource, "unknown">,
): ReasoningEffortCapabilities | undefined {
  const reasoning = overrides?.reasoning;
  if (reasoning === undefined) return undefined;
  if (reasoning === false || reasoning.efforts.length === 0) return { status: "unsupported", source };
  return omitUndefined({
    status: "known",
    source,
    efforts: [...reasoning.efforts],
    defaultEffort: reasoning.defaultEffort,
  });
}
function intersectReasoning(
  model: ReasoningEffortCapabilities,
  connection: ReasoningEffortCapabilities | undefined,
): ReasoningEffortCapabilities {
  if (model.status === "unsupported") return model;
  if (connection?.status === "unsupported") return connection;
  if (model.status !== "known" || connection?.status === "unknown") return UNKNOWN;
  if (connection === undefined) return model;
  const efforts = model.efforts.filter((effort) => connection.efforts.includes(effort));
  if (efforts.length === 0) return { status: "unsupported", source: connection.source };
  const defaultEffort = connection.defaultEffort ?? model.defaultEffort;
  return {
    status: "known",
    source: connection.source,
    efforts,
    ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };
}
function intersectCapability(
  field: ModelCapabilityKey,
  values: readonly (CapabilityValue | undefined)[],
): CapabilityValue {
  const unsupported = values.find((value) => value?.status === "unsupported");
  if (unsupported !== undefined) return unsupported;
  if (values.some((value) => value?.status === "unknown")) return UNKNOWN;
  const concrete = values.filter(
    (value): value is Extract<CapabilityValue, { status: "known" }> => value?.status === "known",
  );
  if (concrete.length === 0) return UNKNOWN;
  let value = concrete[0]!.value;
  let source = concrete[0]!.source;
  for (const next of concrete.slice(1)) {
    const previous = JSON.stringify(value);
    if (typeof value === "number" && typeof next.value === "number") value = Math.min(value, next.value);
    else if (Array.isArray(value) && Array.isArray(next.value))
      value = value.filter((item) => (next.value as readonly string[]).includes(item));
    else if (field === "parameters" || field === "structuredOutput.schemaConstraint")
      value = { allOf: [value, next.value] };
    if (JSON.stringify(value) !== previous) source = next.source;
  }
  if (Array.isArray(value) && value.length === 0) return { status: "unsupported", source: concrete.at(-1)!.source };
  return { status: "known", source, value };
}
/** @experimental */
export function builtinAdapterCapabilities(adapter: string): ModelCapabilityFields {
  if (adapter === "google-gemini")
    return Object.fromEntries(
      Object.entries({
        "input.text": true,
        "input.image": true,
        "input.audio": true,
        "input.file": true,
        "input.resource": false,
        "input.image.sources": ["url", "base64"],
        "input.audio.sources": ["url", "base64"],
        "input.file.sources": ["url", "base64"],
        "output.text": true,
        "output.image": true,
        "output.audio": true,
        tools: true,
        "serverTools.webSearch": true,
        "structuredOutput.json": true,
        "structuredOutput.jsonSchema": true,
        "structuredOutput.schemaDialects": ["draft-07", "2020-12"],
        contextCompaction: false,
        "reasoning.modes": ["effort", "budget"],
      }).map(([field, value]) => [field, known(value, "adapter")]),
    );
  if (
    ![
      "openai-responses",
      "openai-chat-completions",
      "deepseek-chat",
      "kimi-chat",
      "zhipu-chat",
      "anthropic-messages",
    ].includes(adapter)
  )
    return {};
  const responses = adapter === "openai-responses";
  const anthropic = adapter === "anthropic-messages";
  const openaiChat = adapter === "openai-chat-completions";
  const values: Partial<Record<ModelCapabilityKey, ModelCapabilityDeclaration>> = {
    "input.text": true,
    "input.image": true,
    "input.audio": false,
    "input.file": responses || anthropic,
    "input.resource": false,
    "input.image.sources": responses || anthropic ? ["url", "base64", "file"] : ["url", "base64"],
    "input.file.sources": responses || anthropic ? ["url", "base64", "file"] : false,
    "output.text": true,
    "output.image": responses,
    "output.audio": false,
    tools: true,
    "serverTools.webSearch": responses || anthropic || openaiChat || adapter === "zhipu-chat",
    "structuredOutput.json": responses || openaiChat,
    "structuredOutput.jsonSchema": responses || openaiChat,
    "structuredOutput.schemaDialects": responses || openaiChat ? ["draft-07", "2020-12"] : false,
    contextCompaction: responses,
    "reasoning.modes": anthropic
      ? ["effort", "budget", "adaptive"]
      : responses
        ? ["effort", "summary"]
        : openaiChat
          ? ["effort"]
          : ["effort", "thinking"],
  };
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, known(value, "adapter")]));
}
interface CatalogReasoningEffort {
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}
const BUILTIN_REASONING_EFFORTS = new Map<string, CatalogReasoningEffort>([
  ...["openai-responses", "openai-chat-completions"].flatMap((adapter) =>
    ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
      (model) =>
        [
          catalogKey(adapter, model),
          { efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
        ] as const,
    ),
  ),
  ...["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"].map(
    (model) =>
      [catalogKey("deepseek-chat", model), { efforts: ["low", "high", "max"], defaultEffort: "high" }] as const,
  ),
]);
function builtinReasoningEffort(selection: ProviderModelSelection): ReasoningEffortCapabilities | undefined {
  const entry = BUILTIN_REASONING_EFFORTS.get(catalogKey(selection.adapter, selection.model));
  return entry === undefined
    ? undefined
    : omitUndefined({
        status: "known",
        source: "builtin",
        efforts: [...entry.efforts],
        defaultEffort: entry.defaultEffort,
      });
}
function catalogKey(adapter: string, model: string): string {
  return `${adapter}\u0000${model}`;
}
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
class ModelListCapabilityDiscovery implements ModelCapabilityDiscovery {
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertCapabilityFields(fields: ModelCapabilityFields): void {
  const declarations: Record<string, ModelCapabilityDeclaration> = {};
  for (const [field, capability] of Object.entries(fields)) {
    if (!MODEL_CAPABILITY_KEYS.includes(field as ModelCapabilityKey) || !isRecord(capability))
      throw new TypeError("Invalid discovered capability field");
    if (capability.status === "unknown" && capability.source === "unknown") continue;
    if (!["user", "provider", "builtin", "adapter"].includes(String(capability.source)))
      throw new TypeError("Invalid capability source");
    if (capability.status === "unsupported") declarations[field] = false;
    else if (capability.status === "known") {
      if (capability.value === false) throw new TypeError("False capability declarations require unsupported status");
      declarations[field] = capability.value as ModelCapabilityDeclaration;
    } else throw new TypeError("Invalid capability status");
  }
  parseMayConfig({
    providers: { metadata: { adapter: "metadata" } },
    models: { metadata: { provider: "metadata", model: "metadata", capabilities: { fields: declarations } } },
  });
}
function assertReasoningCapabilities(capability: ReasoningEffortCapabilities): void {
  if (capability.status === "unknown" && capability.source === "unknown") return;
  if (!["user", "provider", "builtin", "adapter"].includes(capability.source))
    throw new TypeError("Invalid reasoning capability source");
  if (capability.status === "unsupported") return;
  if (capability.status !== "known") throw new TypeError("Invalid reasoning capability status");
  parseMayConfig({
    providers: { metadata: { adapter: "metadata" } },
    models: {
      metadata: {
        provider: "metadata",
        model: "metadata",
        capabilities: {
          reasoning: omitUndefined({ efforts: capability.efforts, defaultEffort: capability.defaultEffort }),
        },
      },
    },
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`);
  return value;
}
