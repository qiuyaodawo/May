import {
  aggregateUsage,
  omitUndefined,
  priceUsage,
  resolveRunBudget,
  resolveUsageTotals,
  validateUsageCost,
  type Usage,
  type UsageCost,
} from "@sortedyuan/may/core";
import type { EvalCase, EvalExecutionEvent, EvalMetrics, EvalVariant, MeasuredValue } from "./types.js";

export function measured(value: number): MeasuredValue {
  return { value, complete: true, missingReasons: [] };
}
function unknown(reason: string): MeasuredValue {
  return { complete: false, missingReasons: [reason] };
}
export class MetricsAccumulator {
  private readonly seen = new Set<string>();
  private readonly counts: Record<string, number> = {};
  private readonly receipts = new Map<string, { usage?: Usage; cost: UsageCost }>();
  constructor(
    private readonly variant: EvalVariant,
    private readonly item: EvalCase,
  ) {}
  record(event: EvalExecutionEvent): void {
    const key = `${event.scope ?? "agent"}:${event.type}:${event.id}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= 10_000) throw new RangeError("Trial telemetry exceeds 10,000 unique events per scope");
    this.seen.add(key);
    const field = (
      {
        "model-call": "modelCalls",
        "model-attempt": "modelAttempts",
        "retry-wait": "retryWaitMs",
        "tool-call": "toolCalls",
        "tool-failure": "toolFailures",
        "context-compaction": "contextCompactions",
        "human-intervention": "humanInterventions",
        "approval-wait": "approvalWaitMs",
      } as Record<string, string>
    )[event.type];
    if (field !== undefined)
      this.counts[field] =
        (this.counts[field] ?? 0) +
        (event.type === "retry-wait" || event.type === "approval-wait" ? (event.durationMs ?? 0) : 1);
    if (event.type === "usage") {
      const budget = resolveRunBudget(this.item.limits.runBudget, this.variant.runBudget);
      this.receipts.set(event.id, {
        ...omitUndefined({ usage: event.usage }),
        cost:
          event.cost === undefined
            ? priceUsage(event.usage, budget.pricing ?? budget.tokenPrices)
            : validateUsageCost(event.cost),
      });
    }
  }
  snapshot(overrides?: EvalMetrics): EvalMetrics {
    let usage: Usage | undefined;
    const missing = new Set<string>();
    for (const receipt of this.receipts.values()) {
      const totals = resolveUsageTotals(receipt.usage);
      totals.missingReasons.forEach((reason) => missing.add(reason));
      usage = aggregateUsage(usage, receipt.usage);
    }
    const totals = resolveUsageTotals(usage);
    const calls = this.counts.modelCalls;
    if (calls !== undefined && calls > this.receipts.size) missing.add("model-call-usage-missing");
    const costs = [...this.receipts.values()].map((value) => value.cost);
    const currencies = new Set(costs.map((value) => value.currency));
    const costReasons = [...new Set(costs.flatMap((value) => value.missingReasons))];
    if (calls !== undefined && calls > costs.length) costReasons.push("model-call-cost-missing");
    if (currencies.size > 1) costReasons.push("multiple-currencies");
    if (costs.length === 0) costReasons.push("cost-not-reported");
    const cost: UsageCost = {
      ...(currencies.size <= 1 && costs.some((value) => value.amount !== undefined)
        ? { amount: costs.reduce((sum, value) => sum + (value.amount ?? 0), 0) }
        : {}),
      currency: costs[0]?.currency ?? "USD",
      kind: costs.length > 0 && costs.every((value) => value.kind === "provider") ? "provider" : "estimated",
      complete:
        costs.length > 0 &&
        calls !== undefined &&
        costs.length >= calls &&
        currencies.size === 1 &&
        costs.every((value) => value.complete),
      missingReasons: costReasons,
      ...(costs.length === 1
        ? omitUndefined({ pricingId: costs[0]!.pricingId, pricingVersion: costs[0]!.pricingVersion })
        : {}),
    };
    const count = (field: string) =>
      this.counts[field] === undefined ? unknown(`${field}-not-reported`) : measured(this.counts[field]!);
    return {
      durationMs: overrides?.durationMs ?? unknown("execution-not-finished"),
      approvalWaitMs: count("approvalWaitMs"),
      modelCalls: count("modelCalls"),
      modelAttempts: count("modelAttempts"),
      retryWaitMs: count("retryWaitMs"),
      toolCalls: count("toolCalls"),
      toolFailures: count("toolFailures"),
      contextCompactions: count("contextCompactions"),
      humanInterventions: count("humanInterventions"),
      totalTokens: {
        ...omitUndefined({ value: totals.totalTokens }),
        complete: calls !== undefined && totals.complete && missing.size === 0,
        missingReasons: [
          ...new Set([
            ...totals.missingReasons,
            ...missing,
            ...(calls === undefined ? ["model-call-count-not-reported"] : []),
          ]),
        ],
      },
      cost,
      ...omitUndefined({ usage }),
    };
  }
}
export function mergeMetrics(previous: EvalMetrics, added: EvalMetrics, overrides?: Partial<EvalMetrics>): EvalMetrics {
  const result = { ...added };
  for (const field of [
    "durationMs",
    "approvalWaitMs",
    "modelCalls",
    "modelAttempts",
    "retryWaitMs",
    "toolCalls",
    "toolFailures",
    "contextCompactions",
    "humanInterventions",
    "totalTokens",
  ] as const) {
    const a = previous[field];
    const b = added[field];
    result[field] = {
      ...(a.value === undefined && b.value === undefined ? {} : { value: (a.value ?? 0) + (b.value ?? 0) }),
      complete: a.complete && b.complete,
      missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons])],
    };
  }
  const a = previous.cost;
  const b = added.cost;
  result.cost = {
    currency: a.currency,
    kind: a.kind === b.kind ? a.kind : "estimated",
    complete: a.complete && b.complete && a.currency === b.currency,
    missingReasons: [
      ...new Set([
        ...a.missingReasons,
        ...b.missingReasons,
        ...(a.currency === b.currency ? [] : ["multiple-currencies"]),
      ]),
    ],
    ...(a.currency === b.currency && (a.amount !== undefined || b.amount !== undefined)
      ? { amount: (a.amount ?? 0) + (b.amount ?? 0) }
      : {}),
  };
  return { ...result, ...overrides };
}
export function addMetricOverrides(
  previous: Partial<EvalMetrics> | undefined,
  next: Partial<EvalMetrics>,
): Partial<EvalMetrics> {
  if (previous === undefined) return next;
  const merged: Partial<EvalMetrics> = { ...previous, ...next };
  for (const field of [
    "durationMs",
    "approvalWaitMs",
    "modelCalls",
    "modelAttempts",
    "retryWaitMs",
    "toolCalls",
    "toolFailures",
    "contextCompactions",
    "humanInterventions",
    "totalTokens",
  ] as const) {
    const a = previous[field];
    const b = next[field];
    if (a !== undefined && b !== undefined)
      (merged as Record<string, unknown>)[field] = {
        ...(a.value === undefined && b.value === undefined ? {} : { value: (a.value ?? 0) + (b.value ?? 0) }),
        complete: a.complete && b.complete,
        missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons])],
      };
  }
  if (previous.cost !== undefined && next.cost !== undefined) {
    const a = previous.cost;
    const b = next.cost;
    (merged as Record<string, unknown>).cost = {
      currency: a.currency,
      kind: a.kind === b.kind ? a.kind : "estimated",
      complete: a.complete && b.complete && a.currency === b.currency,
      missingReasons: [
        ...new Set([
          ...a.missingReasons,
          ...b.missingReasons,
          ...(a.currency === b.currency ? [] : ["multiple-currencies"]),
        ]),
      ],
      ...(a.currency === b.currency && (a.amount !== undefined || b.amount !== undefined)
        ? { amount: (a.amount ?? 0) + (b.amount ?? 0) }
        : {}),
    };
  }
  if (previous.usage !== undefined || next.usage !== undefined)
    (merged as Record<string, unknown>).usage = aggregateUsage(previous.usage, next.usage);
  return merged;
}
