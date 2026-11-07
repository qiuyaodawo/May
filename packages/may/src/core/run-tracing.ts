import { RunCancelledError } from "./errors.js";
import type { Model } from "./model.js";
import { omitUndefined } from "./omit-undefined.js";
import { resolveUsageTotals, type UsageCost } from "./pricing.js";
import {
  endTraceSpan,
  startTraceSpan,
  traceError,
  type TraceAttributes,
  type TraceContext,
  type TraceSpan,
  type Tracer,
} from "./tracing.js";
import type { Usage } from "./types.js";

export async function traceOperation<T>(
  tracer: Tracer | undefined,
  name: string,
  parent: TraceContext | undefined,
  attributes: TraceAttributes,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const span = startTraceSpan(tracer, name, omitUndefined({ parent, attributes }));
  try {
    const value = await operation();
    endTraceSpan(span, { status: "ok" });
    return value;
  } catch (error) {
    endOperationSpan(span, error, signal);
    throw error;
  }
}

export function endOperationSpan(span: TraceSpan | undefined, error: unknown, signal: AbortSignal): void {
  endTraceSpan(span, {
    status: signal.aborted || error instanceof RunCancelledError ? "cancelled" : "error",
    error: traceError(error),
  });
}

export function modelConfigurationTraceAttributes(model: Model): TraceAttributes {
  const attributes: Record<string, string | number | boolean> = {};
  const configuration = model.configuration ?? {};
  const fields = {
    provider: "provider",
    adapter: "adapter",
    model: "name",
    profile: "profile",
    reasoningEffort: "reasoning_effort",
    capabilityVersion: "capability_version",
  };
  for (const [key, attribute] of Object.entries(fields)) {
    const value = configuration[key];
    if (value !== undefined) attributes[`may.model.${attribute}`] = value;
  }
  if (model.capabilityVersion !== undefined) attributes["may.model.capability_version"] = model.capabilityVersion;
  return attributes;
}

export function usageTraceAttributes(usage: Usage | undefined, prefix = "may.run"): TraceAttributes {
  if (usage === undefined) return { [`${prefix}.usage_complete`]: false };
  return omitUndefined({
    [`${prefix}.cached_read_tokens`]: usage.cachedReadTokens,
    [`${prefix}.cached_write_tokens`]: usage.cachedWriteTokens,
    [`${prefix}.reasoning_tokens`]: usage.reasoningTokens,
    [`${prefix}.usage_complete`]: resolveUsageTotals(usage).complete,
    [`${prefix}.input_tokens`]: usage.inputTokens,
    [`${prefix}.output_tokens`]: usage.outputTokens,
    [`${prefix}.total_tokens`]: usage.totalTokens,
  }) as TraceAttributes;
}

export function costTraceAttributes(cost: UsageCost): TraceAttributes {
  return omitUndefined({
    "may.model.cost": cost.amount,
    "may.model.currency": cost.currency,
    "may.model.cost_kind": cost.kind,
    "may.model.cost_complete": cost.complete,
    "may.model.pricing_version": cost.pricingVersion,
    "may.model.pricing_id": cost.pricingId,
  });
}
