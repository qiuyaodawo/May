import { createHash } from "node:crypto";
import {
  MODEL_CAPABILITY_KEYS,
  type ModelCapabilityDeclaration,
  type ModelCapabilityKey,
} from "@sortedyuan/may/config";
import { omitUndefined, type ModelRequest } from "@sortedyuan/may/core";
import { builtinAdapterCapabilities, builtinReasoningEffort } from "./builtin-capabilities.js";
import {
  UNKNOWN,
  assertCapabilityFields,
  assertReasoningCapabilities,
  declaredFields,
  declaredLimit,
  declaredReasoning,
  intersectCapability,
  intersectReasoning,
  isRecord,
  known,
} from "./capability-values.js";
import { ModelListCapabilityDiscovery } from "./model-list-discovery.js";
import type { ProviderModelSelection } from "./types.js";
import { selectionWebSearch } from "./web-search.js";

export { MODEL_CAPABILITY_KEYS, builtinAdapterCapabilities };
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
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`);
  return value;
}
