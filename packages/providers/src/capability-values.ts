import {
  MODEL_CAPABILITY_KEYS,
  parseMayConfig,
  type ModelCapabilityDeclaration,
  type ModelCapabilitiesOverride,
  type ModelCapabilityKey,
} from "@sortedyuan/may/config";
import { omitUndefined } from "@sortedyuan/may/core";
import type {
  CapabilityValue,
  ModelCapabilityFields,
  ModelCapabilitySource,
  ReasoningEffortCapabilities,
} from "./capabilities.js";
import type { ProviderModelSelection } from "./types.js";

export const UNKNOWN = { status: "unknown", source: "unknown" } as const;
export function known(
  value: ModelCapabilityDeclaration,
  source: Exclude<ModelCapabilitySource, "unknown">,
): CapabilityValue {
  return value === false ? { status: "unsupported", source } : { status: "known", source, value };
}
export function declaredFields(
  overrides: ModelCapabilitiesOverride | undefined,
  source: Exclude<ModelCapabilitySource, "unknown">,
): ModelCapabilityFields {
  return Object.fromEntries(
    Object.entries(overrides?.fields ?? {}).map(([field, value]) => [field, known(value, source)]),
  );
}
export function declaredLimit(
  selection: ProviderModelSelection,
  field: ModelCapabilityKey,
): CapabilityValue | undefined {
  if (field !== "contextWindowTokens" && field !== "maxOutputTokens") return undefined;
  const value = selection.limits?.[field];
  return value === undefined ? undefined : known(value, "user");
}
export function declaredReasoning(
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
export function intersectReasoning(
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
export function intersectCapability(
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
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertCapabilityFields(fields: ModelCapabilityFields): void {
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
export function assertReasoningCapabilities(capability: ReasoningEffortCapabilities): void {
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
