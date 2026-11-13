import { omitUndefined } from "./omit-undefined.js";
import type { Usage, UsageItem, UsageTokenRelation } from "./types.js";
import { boundedText, currency, detailFields, nonnegative, object } from "./usage-checks.js";

/** @experimental */
export interface UsageTotals {
  readonly totalTokens?: number;
  readonly complete: boolean;
  readonly missingReasons: readonly string[];
}

/** @experimental */
export function resolveUsageTotals(usage?: Usage): UsageTotals {
  if (usage === undefined) return { complete: false, missingReasons: ["usage-missing"] };
  validateUsage(usage);
  const missing =
    usage.completeness !== undefined && usage.completeness.status !== "complete"
      ? [usage.completeness.reason ?? `usage-${usage.completeness.status}`]
      : [];
  let components =
    usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined;
  for (const [field, relationKey] of detailFields) {
    const tokens = usage[field];
    if (tokens === undefined || tokens === 0) continue;
    const relation = usage.tokenRelations?.[relationKey] ?? "unknown";
    if (relation === "unknown") missing.push(`${field}-relation-unknown`);
    if ((relation === "total" || relation === "none") && components !== undefined) components += tokens;
  }
  const quantities = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedRead: usage.cachedReadTokens,
    cachedWrite: usage.cachedWriteTokens,
    reasoning: usage.reasoningTokens,
  };
  for (const item of usage.items ?? []) {
    if (item.quantity === 0 || item.unit !== "tokens" || item.includedIn === "cost" || item.includedIn === "none")
      continue;
    if (item.includedIn === "unknown") missing.push(`item-${item.id}-relation-unknown`);
    else if (quantities[item.includedIn] === undefined) missing.push(`item-${item.id}-containing-usage-missing`);
  }
  const standaloneItems = (usage.items ?? []).reduce(
    (sum, item) => sum + (item.unit === "tokens" && item.includedIn === "none" ? item.quantity : 0),
    0,
  );
  if (components !== undefined) components += standaloneItems;
  const standalone = detailFields.reduce(
    (sum, [field, relationKey]) => sum + (usage.tokenRelations?.[relationKey] === "none" ? (usage[field] ?? 0) : 0),
    standaloneItems,
  );
  const totalTokens = usage.totalTokens === undefined ? components : usage.totalTokens + standalone;
  if (totalTokens === undefined) missing.push("total-tokens-missing");
  if (components !== undefined && !Number.isSafeInteger(components))
    throw new RangeError("Usage total exceeds a safe integer");
  if (totalTokens !== undefined && !Number.isSafeInteger(totalTokens))
    throw new RangeError("Usage total exceeds a safe integer");
  if (usage.totalTokens !== undefined && components !== undefined && totalTokens! < components)
    throw new RangeError("Usage totalTokens is smaller than its included components");
  return omitUndefined({ totalTokens, complete: missing.length === 0, missingReasons: missing });
}

/** @experimental */
export function aggregateUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (current === undefined && next === undefined) return undefined;
  if (current === undefined) return next === undefined ? undefined : structuredClone(next);
  if (next === undefined)
    return { ...structuredClone(current), completeness: { status: "partial", reason: "response-usage-missing" } };
  const currentTotals = resolveUsageTotals(current);
  const nextTotals = resolveUsageTotals(next);
  const usage: Usage = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "reasoningTokens",
  ] as const) {
    if (current[field] !== undefined || next[field] !== undefined)
      usage[field] = (current[field] ?? 0) + (next[field] ?? 0);
  }
  const relations: NonNullable<Usage["tokenRelations"]> = {};
  for (const [field, key] of detailFields) {
    if (usage[field] === undefined) continue;
    const left =
      current[field] === undefined || current[field] === 0 ? undefined : (current.tokenRelations?.[key] ?? "unknown");
    const right =
      next[field] === undefined || next[field] === 0 ? undefined : (next.tokenRelations?.[key] ?? "unknown");
    relations[key] =
      left === undefined ? (right ?? "unknown") : right === undefined || left === right ? left : "unknown";
  }
  if (Object.keys(relations).length > 0) usage.tokenRelations = relations;
  if (current.totalTokens !== undefined || next.totalTokens !== undefined) {
    const providerTotal = (source: Usage, totals: UsageTotals) =>
      source.totalTokens ??
      (totals.totalTokens === undefined
        ? 0
        : totals.totalTokens -
          detailFields.reduce(
            (sum, [field, key]) => sum + (source.tokenRelations?.[key] === "none" ? (source[field] ?? 0) : 0),
            0,
          ) -
          (source.items ?? []).reduce(
            (sum, item) => sum + (item.unit === "tokens" && item.includedIn === "none" ? item.quantity : 0),
            0,
          ));
    usage.totalTokens = providerTotal(current, currentTotals) + providerTotal(next, nextTotals);
  }
  const items = new Map<string, NonNullable<Usage["items"]>[number]>();
  for (const item of [...(current.items ?? []), ...(next.items ?? [])]) {
    const existing = items.get(item.id);
    if (existing !== undefined && existing.unit !== item.unit)
      throw new TypeError(`Usage item ${item.id} has inconsistent units`);
    items.set(
      item.id,
      existing === undefined
        ? { ...item }
        : {
            ...item,
            quantity: existing.quantity + item.quantity,
            includedIn: existing.includedIn === item.includedIn ? item.includedIn : "unknown",
          },
    );
  }
  if (items.size > 0) usage.items = [...items.values()];
  if (
    current.reportedCost !== undefined &&
    next.reportedCost !== undefined &&
    current.reportedCost.currency === next.reportedCost.currency
  ) {
    usage.reportedCost = {
      amount: current.reportedCost.amount + next.reportedCost.amount,
      currency: current.reportedCost.currency,
      source:
        current.reportedCost.source === next.reportedCost.source ? current.reportedCost.source : "multiple-providers",
    };
  }
  if (!currentTotals.complete || !nextTotals.complete)
    usage.completeness = { status: "partial", reason: "response-usage-incomplete" };
  validateUsage(usage);
  return usage;
}

function validateUsage(usage: Usage): void {
  object(usage, "usage");
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "reasoningTokens",
  ] as const) {
    if (usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || usage[field]! < 0))
      throw new RangeError(`usage.${field} must be a non-negative safe integer`);
  }
  if (usage.tokenRelations !== undefined) {
    object(usage.tokenRelations, "usage.tokenRelations");
    for (const [key, relation] of Object.entries(usage.tokenRelations)) {
      if (
        !["cachedRead", "cachedWrite", "reasoning"].includes(key) ||
        !["input", "output", "total", "none", "unknown"].includes(relation as UsageTokenRelation)
      )
        throw new TypeError("Invalid usage token relationship");
    }
    for (const [field, key] of detailFields) {
      const relation = usage.tokenRelations[key];
      if (
        usage[field] !== undefined &&
        relation === "input" &&
        usage.inputTokens !== undefined &&
        usage[field]! > usage.inputTokens
      )
        throw new RangeError(`${field} exceeds inputTokens`);
      if (
        usage[field] !== undefined &&
        relation === "output" &&
        usage.outputTokens !== undefined &&
        usage[field]! > usage.outputTokens
      )
        throw new RangeError(`${field} exceeds outputTokens`);
    }
  }
  if (usage.completeness !== undefined) {
    object(usage.completeness, "usage.completeness");
    if (!["complete", "partial", "unavailable"].includes(usage.completeness.status))
      throw new TypeError("Invalid usage completeness");
    if (usage.completeness.reason !== undefined) boundedText(usage.completeness.reason, "usage completeness reason");
  }
  if (usage.reportedCost !== undefined) {
    object(usage.reportedCost, "usage.reportedCost");
    nonnegative(usage.reportedCost.amount, "reported cost");
    currency(usage.reportedCost.currency);
    boundedText(usage.reportedCost.source, "reported cost source");
  }
  if (usage.items !== undefined) {
    if (!Array.isArray(usage.items) || usage.items.length > 64)
      throw new RangeError("usage.items must be an array of at most 64 entries");
    const ids = new Set<string>();
    const subsets = new Map<string, number>();
    for (const item of usage.items as readonly UsageItem[]) {
      object(item, "usage item");
      boundedText(item.id, "usage item id");
      boundedText(item.unit, "usage item unit");
      nonnegative(item.quantity, "usage item quantity");
      if (
        ids.has(item.id) ||
        !["input", "output", "cachedRead", "cachedWrite", "reasoning", "cost", "none", "unknown"].includes(
          item.includedIn,
        )
      )
        throw new TypeError("Invalid or duplicate usage item");
      if (
        ["input", "output", "cachedRead", "cachedWrite", "reasoning"].includes(item.includedIn) &&
        (item.unit !== "tokens" || !Number.isSafeInteger(item.quantity))
      )
        throw new TypeError("A token subset must use an integer tokens quantity");
      if (["input", "output", "cachedRead", "cachedWrite", "reasoning"].includes(item.includedIn)) {
        subsets.set(item.includedIn, (subsets.get(item.includedIn) ?? 0) + item.quantity);
      }
      ids.add(item.id);
    }
    const quantities = {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cachedRead: usage.cachedReadTokens,
      cachedWrite: usage.cachedWriteTokens,
      reasoning: usage.reasoningTokens,
    };
    for (const [key, total] of subsets) {
      const containing = quantities[key as keyof typeof quantities];
      if (containing !== undefined && total > containing)
        throw new RangeError(`Usage item subsets exceed ${key} token count`);
    }
  }
}
