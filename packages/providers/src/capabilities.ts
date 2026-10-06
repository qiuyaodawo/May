import { createHash } from "node:crypto";
import { MODEL_CAPABILITY_KEYS, parseMayConfig, type ModelCapabilityDeclaration, type ModelCapabilitiesOverride, type ModelCapabilityKey } from "@may/config";
import type { ModelRequest } from "@may/core";
import type { ProviderModelSelection } from "./types.js";

export { MODEL_CAPABILITY_KEYS };
export type { ModelCapabilityKey, ModelCapabilityDeclaration };
export type ModelCapabilitySource = "user" | "provider" | "builtin" | "adapter" | "unknown";
export type ModelCapabilityLayer = "model" | "adapter" | "connection";
export type CapabilityValue<T = ModelCapabilityDeclaration> =
  | { readonly status: "known"; readonly source: Exclude<ModelCapabilitySource, "unknown">; readonly value: T }
  | { readonly status: "unsupported"; readonly source: Exclude<ModelCapabilitySource, "unknown"> }
  | { readonly status: "unknown"; readonly source: "unknown" };
export type ReasoningEffortCapabilities =
  | { readonly status: "known"; readonly source: Exclude<ModelCapabilitySource, "unknown">; readonly efforts: readonly string[]; readonly defaultEffort?: string }
  | { readonly status: "unsupported"; readonly source: Exclude<ModelCapabilitySource, "unknown"> }
  | { readonly status: "unknown"; readonly source: "unknown" };
export type ModelCapabilityFields = Readonly<Partial<Record<ModelCapabilityKey, CapabilityValue>>>;
export interface ModelCapabilityDiagnostic {
  readonly discovery: string;
  readonly code: "DISCOVERY_FAILED";
  readonly observedAt: number;
}
export interface ModelCapabilities {
  readonly reasoningEffort: ReasoningEffortCapabilities;
  readonly fields?: ModelCapabilityFields;
  readonly layers?: Readonly<Record<ModelCapabilityLayer, ModelCapabilityFields>>;
  readonly version?: string;
  readonly observedAt?: number;
  readonly expiresAt?: number;
  readonly diagnostics?: readonly ModelCapabilityDiagnostic[];
}
export interface ModelCapabilityDiscovery {
  readonly name?: string;
  discoverReasoningEffort?(selection: ProviderModelSelection): Promise<ReasoningEffortCapabilities | undefined>;
  discoverCapabilities?(selection: ProviderModelSelection, fields?: readonly ModelCapabilityKey[]): Promise<ModelCapabilityFields | undefined>;
}
export interface ModelCapabilityResolverOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly discoveries?: readonly ModelCapabilityDiscovery[];
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly maxVerificationRecords?: number;
  readonly adapterCapabilities?: Readonly<Record<string, ModelCapabilityFields>>;
}
export interface ResolveModelCapabilitiesOptions {
  readonly fields?: readonly ModelCapabilityKey[];
  readonly refresh?: boolean;
}
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
    this.discoveries = options.discoveries ?? [new CpaCodexCapabilityDiscovery(options.fetch ?? globalThis.fetch)];
    this.ttl = positive(options.cacheTtlMs ?? 300_000, "cacheTtlMs");
    this.maxEntries = positive(options.maxCacheEntries ?? 128, "maxCacheEntries");
    this.maxRecords = positive(options.maxVerificationRecords ?? 256, "maxVerificationRecords");
    this.adapters = structuredClone(options.adapterCapabilities ?? {});
    for (const fields of Object.values(this.adapters)) assertCapabilityFields(fields);
  }
  async resolve(selection: ProviderModelSelection, options: ResolveModelCapabilitiesOptions = {}): Promise<ModelCapabilities> {
    const requested = options.fields ?? MODEL_CAPABILITY_KEYS;
    for (const field of requested) if (!MODEL_CAPABILITY_KEYS.includes(field)) throw new TypeError(`Unknown capability field ${field}`);
    const explicit = declaredFields(selection.capabilities, "user");
    assertCapabilityFields(explicit);
    const explicitReasoning = declaredReasoning(selection.capabilities, "user");
    if (explicitReasoning !== undefined) assertReasoningCapabilities(explicitReasoning);
    const discovered = await this.discover(selection, options.refresh === true, explicitReasoning !== undefined, requested);
    const model: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    const adapter = this.adapters[selection.adapter] ?? builtinAdapterCapabilities(selection.adapter);
    const connection = declaredFields(selection.providerConfig.capabilities, "user");
    assertCapabilityFields(connection);
    const connectionReasoning = declaredReasoning(selection.providerConfig.capabilities, "user");
    if (connectionReasoning !== undefined) assertReasoningCapabilities(connectionReasoning);
    const effective: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    for (const field of requested) {
      const value = explicit[field] ?? declaredLimit(selection, field) ?? discovered.fields[field] ?? UNKNOWN;
      model[field] = value;
      effective[field] = intersectCapability(field, [value, adapter[field], connection[field]]);
    }
    const reasoning = explicitReasoning ?? discovered.reasoningEffort ?? builtinReasoningEffort(selection) ?? UNKNOWN;
    const reasoningEffort = intersectReasoning(reasoning, connectionReasoning);
    const layers = { model, adapter, connection };
    return structuredClone({ reasoningEffort, fields: effective, layers, version: digest({ reasoningEffort, fields: effective, layers }), observedAt: discovered.observedAt, expiresAt: discovered.expiresAt, diagnostics: discovered.diagnostics });
  }
  invalidate(selection?: ProviderModelSelection): void {
    if (selection === undefined) {
      this.cache.clear(); this.pending.clear(); return;
    }
    const prefix = connectionIdentity(selection);
    for (const key of [...this.cache.keys(), ...this.pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.cache.delete(key); this.pending.delete(key);
    }
  }
  verificationRecords(selection?: ProviderModelSelection): readonly ModelCapabilityVerificationRecord[] {
    const connectionId = selection === undefined ? undefined : connectionIdentity(selection);
    return this.records.filter((record) => connectionId === undefined || (record.connectionId === connectionId && record.model === selection?.model)).map((record) => ({ ...record, parameters: { ...record.parameters } }));
  }
  recordVerification(selection: ProviderModelSelection, request: ModelRequest, success: boolean, responseValidated = false, additionalCapabilities: readonly ModelCapabilityKey[] = []): void {
    const used = new Set<ModelCapabilityKey>(additionalCapabilities);
    for (const message of request.messages) for (const part of message.content) {
      if (part.type === "text" || part.type === "json") used.add("input.text");
      if (["image", "audio", "file", "resource"].includes(part.type)) used.add(`input.${part.type}` as ModelCapabilityKey);
    }
    if (request.tools.length > 0) used.add("tools");
    if (request.responseFormat !== undefined) used.add(request.responseFormat.type === "json" ? "structuredOutput.json" : "structuredOutput.jsonSchema");
    const thinking = selection.options.thinking;
    const activeThinking = thinking !== undefined && thinking !== "disabled" && !(isRecord(thinking) && thinking.type === "disabled");
    if (selection.options.reasoningEffort !== undefined || activeThinking || selection.options.reasoningSummary !== undefined) used.add("reasoning.modes");
    const parameters: Record<string, string | number | boolean> = {};
    if (typeof selection.options.reasoningEffort === "string") parameters.reasoningEffort = selection.options.reasoningEffort;
    for (const key of ["maxTokens", "maxOutputTokens"] as const) if (typeof selection.options[key] === "number") parameters[key] = selection.options[key];
    if (parameters.maxTokens === undefined && parameters.maxOutputTokens === undefined && selection.limits?.maxOutputTokens !== undefined) {
      parameters[["deepseek-chat", "kimi-chat", "zhipu-chat", "anthropic-messages"].includes(selection.adapter) ? "maxTokens" : "maxOutputTokens"] = selection.limits.maxOutputTokens;
    }
    if (typeof selection.options.reasoningSummary === "string") parameters.reasoningSummary = selection.options.reasoningSummary;
    if (typeof thinking === "string") parameters.thinkingType = thinking;
    else if (isRecord(thinking)) {
      if (typeof thinking.type === "string") parameters.thinkingType = thinking.type;
      if (typeof thinking.budgetTokens === "number") parameters.thinkingBudgetTokens = thinking.budgetTokens;
    }
    if (request.responseFormat?.type === "jsonSchema") { parameters.schemaVersion = digest(request.responseFormat.schema); parameters.strict = request.responseFormat.strict ?? false; }
    for (const capability of used) {
      const observed: Record<string, string | number | boolean> = { ...parameters };
      const parts = request.messages.flatMap((message) => message.content).filter((part) => capability === "input.text" ? part.type === "text" || part.type === "json" : capability === `input.${part.type}`);
      if (capability.startsWith("input.")) observed.count = parts.length;
      const media = parts.filter((part) => part.type === "image" || part.type === "audio" || part.type === "file");
      if (media.length > 0) {
        for (const source of ["url", "base64", "file"] as const) observed[`${source}Sources`] = media.filter((part) => part.source.type === source).length;
        const base64 = media.flatMap((part) => part.source.type === "base64" ? [part.source] : []);
        const bytes = base64.map((source) => Buffer.byteLength(source.data, "base64"));
        observed.knownBytesCount = bytes.length;
        if (bytes.length > 0) { observed.minObservedBytes = Math.min(...bytes); observed.maxObservedBytes = Math.max(...bytes); }
        observed.mediaTypesVersion = digest([...new Set(base64.map((source) => source.mediaType))].sort());
      }
      if (capability === "tools") { observed.definitions = request.tools.length; observed.definitionsVersion = digest(request.tools); }
      const evidence = !success ? "failed" : capability.startsWith("structuredOutput.") && responseValidated ? "response-validated" : "request-accepted";
      this.records.push({ model: selection.model, adapter: selection.adapter, connectionId: connectionIdentity(selection), capability, observedAt: Date.now(), success, evidence, parameters: observed });
    }
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
  }
  private async discover(selection: ProviderModelSelection, refresh: boolean, skipReasoning: boolean, fields: readonly ModelCapabilityKey[]): Promise<DiscoveryResult> {
    const key = `${connectionIdentity(selection)}:${digest({ model: selection.model, fields: [...fields].sort(), skipReasoning })}`;
    if (refresh) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
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
    } finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
  private async query(selection: ProviderModelSelection, skipReasoning: boolean, requested: readonly ModelCapabilityKey[]): Promise<DiscoveryResult> {
    const fields: Partial<Record<ModelCapabilityKey, CapabilityValue>> = {};
    let reasoningEffort: ReasoningEffortCapabilities | undefined;
    const diagnostics: ModelCapabilityDiagnostic[] = [];
    for (const [index, discovery] of this.discoveries.entries()) {
      let found: ModelCapabilityFields | undefined;
      let foundReasoning: ReasoningEffortCapabilities | undefined;
      try {
        found = await discovery.discoverCapabilities?.(selection, requested);
        if (!skipReasoning && reasoningEffort === undefined) foundReasoning = await discovery.discoverReasoningEffort?.(selection);
      } catch { diagnostics.push({ discovery: discovery.name ?? `discovery-${index + 1}`, code: "DISCOVERY_FAILED", observedAt: Date.now() }); continue; }
      if (found !== undefined) assertCapabilityFields(found);
      if (foundReasoning !== undefined) assertReasoningCapabilities(foundReasoning);
      if (found !== undefined) for (const field of requested) if (fields[field] === undefined && found[field] !== undefined) fields[field] = found[field];
      reasoningEffort ??= foundReasoning;
    }
    const observedAt = Date.now();
    return { fields, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), observedAt, expiresAt: observedAt + this.ttl, diagnostics };
  }
}
export function createModelCapabilityResolver(options: ModelCapabilityResolverOptions = {}): ModelCapabilityResolver { return new ModelCapabilityResolver(options); }
export function connectionIdentity(selection: ProviderModelSelection): string { return digest({ provider: selection.provider, adapter: selection.adapter, config: selection.providerConfig }); }
const UNKNOWN = { status: "unknown", source: "unknown" } as const;
function known(value: ModelCapabilityDeclaration, source: Exclude<ModelCapabilitySource, "unknown">): CapabilityValue { return value === false ? { status: "unsupported", source } : { status: "known", source, value }; }
function declaredFields(overrides: ModelCapabilitiesOverride | undefined, source: Exclude<ModelCapabilitySource, "unknown">): ModelCapabilityFields { return Object.fromEntries(Object.entries(overrides?.fields ?? {}).map(([field, value]) => [field, known(value, source)])); }
function declaredLimit(selection: ProviderModelSelection, field: ModelCapabilityKey): CapabilityValue | undefined {
  if (field !== "contextWindowTokens" && field !== "maxOutputTokens") return undefined;
  const value = selection.limits?.[field];
  return value === undefined ? undefined : known(value, "user");
}
function declaredReasoning(overrides: ModelCapabilitiesOverride | undefined, source: Exclude<ModelCapabilitySource, "unknown">): ReasoningEffortCapabilities | undefined {
  const reasoning = overrides?.reasoning;
  if (reasoning === undefined) return undefined;
  if (reasoning === false || reasoning.efforts.length === 0) return { status: "unsupported", source };
  return { status: "known", source, efforts: [...reasoning.efforts], ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }) };
}
function intersectReasoning(model: ReasoningEffortCapabilities, connection: ReasoningEffortCapabilities | undefined): ReasoningEffortCapabilities {
  if (model.status === "unsupported") return model;
  if (connection?.status === "unsupported") return connection;
  if (model.status !== "known" || connection?.status === "unknown") return UNKNOWN;
  if (connection === undefined) return model;
  const efforts = model.efforts.filter((effort) => connection.efforts.includes(effort));
  if (efforts.length === 0) return { status: "unsupported", source: connection.source };
  const defaultEffort = connection.defaultEffort ?? model.defaultEffort;
  return { status: "known", source: connection.source, efforts, ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}) };
}
function intersectCapability(field: ModelCapabilityKey, values: readonly (CapabilityValue | undefined)[]): CapabilityValue {
  const unsupported = values.find((value) => value?.status === "unsupported");
  if (unsupported !== undefined) return unsupported;
  if (values.some((value) => value?.status === "unknown")) return UNKNOWN;
  const concrete = values.filter((value): value is Extract<CapabilityValue, { status: "known" }> => value?.status === "known");
  if (concrete.length === 0) return UNKNOWN;
  let value = concrete[0]!.value;
  let source = concrete[0]!.source;
  for (const next of concrete.slice(1)) {
    const previous = JSON.stringify(value);
    if (typeof value === "number" && typeof next.value === "number") value = Math.min(value, next.value);
    else if (Array.isArray(value) && Array.isArray(next.value)) value = value.filter((item) => (next.value as readonly string[]).includes(item));
    else if (field === "parameters" || field === "structuredOutput.schemaConstraint") value = { allOf: [value, next.value] };
    if (JSON.stringify(value) !== previous) source = next.source;
  }
  if (Array.isArray(value) && value.length === 0) return { status: "unsupported", source: concrete.at(-1)!.source };
  return { status: "known", source, value };
}
export function builtinAdapterCapabilities(adapter: string): ModelCapabilityFields {
  if (!["openai-responses", "openai-chat-completions", "deepseek-chat", "kimi-chat", "zhipu-chat", "anthropic-messages"].includes(adapter)) return {};
  const responses = adapter === "openai-responses";
  const anthropic = adapter === "anthropic-messages";
  const openaiChat = adapter === "openai-chat-completions";
  const values: Partial<Record<ModelCapabilityKey, ModelCapabilityDeclaration>> = {
    "input.text": true, "input.image": true, "input.audio": false, "input.file": responses || anthropic,
    "input.resource": false, "input.image.sources": responses || anthropic ? ["url", "base64", "file"] : ["url", "base64"],
    "input.file.sources": responses || anthropic ? ["url", "base64", "file"] : false,
    "output.text": true, "output.image": responses, "output.audio": false, tools: true,
    "structuredOutput.json": responses || openaiChat, "structuredOutput.jsonSchema": responses || openaiChat,
    "structuredOutput.schemaDialects": responses || openaiChat ? ["draft-07", "2020-12"] : false,
    contextCompaction: responses,
    "reasoning.modes": anthropic ? ["effort", "budget", "adaptive"] : responses ? ["effort", "summary"] : openaiChat ? ["effort"] : ["effort", "thinking"],
  };
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, known(value, "adapter")]));
}
interface CatalogReasoningEffort { readonly efforts: readonly string[]; readonly defaultEffort?: string }
const BUILTIN_REASONING_EFFORTS = new Map<string, CatalogReasoningEffort>([
  ...["openai-responses", "openai-chat-completions"].flatMap((adapter) => ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((model) => [catalogKey(adapter, model), { efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }] as const)),
  ...["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"].map((model) => [catalogKey("deepseek-chat", model), { efforts: ["low", "high", "max"], defaultEffort: "high" }] as const),
]);
function builtinReasoningEffort(selection: ProviderModelSelection): ReasoningEffortCapabilities | undefined {
  const entry = BUILTIN_REASONING_EFFORTS.get(catalogKey(selection.adapter, selection.model));
  return entry === undefined ? undefined : { status: "known", source: "builtin", efforts: [...entry.efforts], ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }) };
}
function catalogKey(adapter: string, model: string): string { return `${adapter}\u0000${model}`; }
class CpaCodexCapabilityDiscovery implements ModelCapabilityDiscovery {
  readonly name = "cpa-codex";
  constructor(private readonly fetchImplementation: typeof globalThis.fetch) {}
  async discoverReasoningEffort(selection: ProviderModelSelection): Promise<ReasoningEffortCapabilities | undefined> {
    if (!["openai-responses", "openai-chat-completions"].includes(selection.adapter)) return undefined;
    const baseURL = selection.providerConfig.baseURL;
    if (baseURL === undefined) return undefined;
    const apiKey = selection.providerConfig.apiKey;
    const response = await this.fetchImplementation(`${baseURL.replace(/\/+$/u, "")}/models?client_version=may`, { signal: AbortSignal.timeout(10_000), ...(apiKey === undefined || apiKey.trim() === "" ? {} : { headers: { Authorization: `Bearer ${apiKey}` } }) });
    if (!response.ok) throw new Error("Capability catalog request failed");
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
    const model = value.models.find((entry) => isRecord(entry) && entry.slug === selection.model);
    if (!isRecord(model) || !Array.isArray(model.supported_reasoning_levels)) return undefined;
    const efforts = [...new Set(model.supported_reasoning_levels.flatMap((level) => { const effort = typeof level === "string" ? level : isRecord(level) ? level.effort : undefined; return typeof effort === "string" && effort.trim() !== "" ? [effort] : []; }))];
    if (efforts.length === 0) return undefined;
    const defaultEffort = model.default_reasoning_level;
    return { status: "known", source: "provider", efforts, ...(typeof defaultEffort === "string" && efforts.includes(defaultEffort) ? { defaultEffort } : {}) };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertCapabilityFields(fields: ModelCapabilityFields): void {
  const declarations: Record<string, ModelCapabilityDeclaration> = {};
  for (const [field, capability] of Object.entries(fields)) {
    if (!MODEL_CAPABILITY_KEYS.includes(field as ModelCapabilityKey) || !isRecord(capability)) throw new TypeError("Invalid discovered capability field");
    if (capability.status === "unknown" && capability.source === "unknown") continue;
    if (!["user", "provider", "builtin", "adapter"].includes(String(capability.source))) throw new TypeError("Invalid capability source");
    if (capability.status === "unsupported") declarations[field] = false;
    else if (capability.status === "known") {
      if (capability.value === false) throw new TypeError("False capability declarations require unsupported status");
      declarations[field] = capability.value as ModelCapabilityDeclaration;
    }
    else throw new TypeError("Invalid capability status");
  }
  parseMayConfig({ providers: { metadata: { adapter: "metadata" } }, models: { metadata: { provider: "metadata", model: "metadata", capabilities: { fields: declarations } } } });
}
function assertReasoningCapabilities(capability: ReasoningEffortCapabilities): void {
  if (capability.status === "unknown" && capability.source === "unknown") return;
  if (!["user", "provider", "builtin", "adapter"].includes(capability.source)) throw new TypeError("Invalid reasoning capability source");
  if (capability.status === "unsupported") return;
  if (capability.status !== "known") throw new TypeError("Invalid reasoning capability status");
  parseMayConfig({ providers: { metadata: { adapter: "metadata" } }, models: { metadata: { provider: "metadata", model: "metadata", capabilities: { reasoning: { efforts: capability.efforts, ...(capability.defaultEffort === undefined ? {} : { defaultEffort: capability.defaultEffort }) } } } } });
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function positive(value: number, field: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`); return value; }
