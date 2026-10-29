import type { Usage, UsageItem, UsageTokenRelation } from "./types.js";

export interface TokenPrices {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cachedReadUsdPerMillion?: number;
  readonly cachedWriteUsdPerMillion?: number;
  readonly reasoningUsdPerMillion?: number;
}

export interface TokenPriceSchedule {
  readonly id: string;
  readonly version: string;
  readonly currency: string;
  readonly source: string;
  readonly effectiveAt: string;
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cachedReadPerMillion?: number;
  readonly cachedWritePerMillion?: number;
  readonly reasoningPerMillion?: number;
  readonly items?: Readonly<Record<string, { readonly unit: string; readonly perUnit: number }>>;
}

export interface UsageCost {
  readonly amount?: number;
  readonly currency: string;
  readonly kind: "estimated" | "provider";
  readonly complete: boolean;
  readonly missingReasons: readonly string[];
  readonly pricingId?: string;
  readonly pricingVersion?: string;
  readonly source?: string;
  readonly effectiveAt?: string;
}

export type UsagePricer = (usage: Readonly<Usage> | undefined, pricing: Readonly<TokenPriceSchedule> | undefined) => UsageCost;

export interface UsageTotals {
  readonly totalTokens?: number;
  readonly complete: boolean;
  readonly missingReasons: readonly string[];
}

const detailFields = [
  ["cachedReadTokens", "cachedRead", "cachedReadPerMillion"],
  ["cachedWriteTokens", "cachedWrite", "cachedWritePerMillion"],
  ["reasoningTokens", "reasoning", "reasoningPerMillion"],
] as const;

export function validateTokenPrices(prices: TokenPrices): void {
  object(prices, "tokenPrices");
  const fields = ["inputUsdPerMillion", "outputUsdPerMillion", "cachedReadUsdPerMillion", "cachedWriteUsdPerMillion", "reasoningUsdPerMillion"];
  for (const [key, value] of Object.entries(prices)) {
    if (!fields.includes(key)) throw new TypeError(`Unknown tokenPrices field: ${key}`);
    nonnegative(value, `tokenPrices.${key}`);
  }
  nonnegative(prices.inputUsdPerMillion, "tokenPrices.inputUsdPerMillion");
  nonnegative(prices.outputUsdPerMillion, "tokenPrices.outputUsdPerMillion");
}

export function resolvePriceSchedule(value?: TokenPriceSchedule | TokenPrices): Readonly<TokenPriceSchedule> | undefined {
  if (value === undefined) return undefined;
  object(value, "pricing");
  if ("inputUsdPerMillion" in value) {
    validateTokenPrices(value);
    return Object.freeze({ id: "legacy-token-prices", version: "1", currency: "USD", source: "host", effectiveAt: "1970-01-01T00:00:00.000Z",
      inputPerMillion: value.inputUsdPerMillion, outputPerMillion: value.outputUsdPerMillion,
      ...(value.cachedReadUsdPerMillion === undefined ? {} : { cachedReadPerMillion: value.cachedReadUsdPerMillion }),
      ...(value.cachedWriteUsdPerMillion === undefined ? {} : { cachedWritePerMillion: value.cachedWriteUsdPerMillion }),
      ...(value.reasoningUsdPerMillion === undefined ? {} : { reasoningPerMillion: value.reasoningUsdPerMillion }) });
  }
  const fields = ["id", "version", "currency", "source", "effectiveAt", "inputPerMillion", "outputPerMillion", "cachedReadPerMillion", "cachedWritePerMillion", "reasoningPerMillion", "items"];
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(`Unknown pricing field: ${key}`);
  for (const key of ["id", "version", "source", "effectiveAt"] as const) boundedText(value[key], `pricing.${key}`);
  currency(value.currency);
  if (!Number.isFinite(Date.parse(value.effectiveAt))) throw new RangeError("pricing.effectiveAt must be a valid timestamp");
  nonnegative(value.inputPerMillion, "pricing.inputPerMillion");
  nonnegative(value.outputPerMillion, "pricing.outputPerMillion");
  for (const key of ["cachedReadPerMillion", "cachedWritePerMillion", "reasoningPerMillion"] as const) if (value[key] !== undefined) nonnegative(value[key], `pricing.${key}`);
  if (value.items !== undefined) {
    object(value.items, "pricing.items");
    if (Object.keys(value.items).length > 64) throw new RangeError("pricing.items exceeds 64 entries");
    for (const [id, rate] of Object.entries(value.items)) {
      boundedText(id, "pricing item id"); object(rate, `pricing.items.${id}`);
      if (Object.keys(rate).some(key => !["unit", "perUnit"].includes(key))) throw new TypeError("Unknown pricing item field");
      boundedText(rate.unit, "pricing item unit"); nonnegative(rate.perUnit, "pricing item rate");
    }
  }
  return Object.freeze({ ...value, ...(value.items === undefined ? {} : { items: Object.freeze(Object.fromEntries(Object.entries(value.items).map(([id, rate]) => [id, Object.freeze({ ...rate })]))) }) });
}

export function resolveUsageTotals(usage?: Usage): UsageTotals {
  if (usage === undefined) return { complete: false, missingReasons: ["usage-missing"] };
  validateUsage(usage);
  const missing = usage.completeness !== undefined && usage.completeness.status !== "complete" ? [usage.completeness.reason ?? `usage-${usage.completeness.status}`] : [];
  let components = usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined;
  for (const [field, relationKey] of detailFields) {
    const tokens = usage[field];
    if (tokens === undefined || tokens === 0) continue;
    const relation = usage.tokenRelations?.[relationKey] ?? "unknown";
    if (relation === "unknown") missing.push(`${field}-relation-unknown`);
    if ((relation === "total" || relation === "none") && components !== undefined) components += tokens;
  }
  const quantities = { input: usage.inputTokens, output: usage.outputTokens, cachedRead: usage.cachedReadTokens, cachedWrite: usage.cachedWriteTokens, reasoning: usage.reasoningTokens };
  for (const item of usage.items ?? []) {
    if (item.quantity === 0 || item.unit !== "tokens" || item.includedIn === "cost" || item.includedIn === "none") continue;
    if (item.includedIn === "unknown") missing.push(`item-${item.id}-relation-unknown`);
    else if (quantities[item.includedIn] === undefined) missing.push(`item-${item.id}-containing-usage-missing`);
  }
  const standaloneItems = (usage.items ?? []).reduce((sum, item) => sum + (item.unit === "tokens" && item.includedIn === "none" ? item.quantity : 0), 0);
  if (components !== undefined) components += standaloneItems;
  const standalone = detailFields.reduce((sum, [field, relationKey]) => sum + (usage.tokenRelations?.[relationKey] === "none" ? usage[field] ?? 0 : 0), standaloneItems);
  const totalTokens = usage.totalTokens === undefined ? components : usage.totalTokens + standalone;
  if (totalTokens === undefined) missing.push("total-tokens-missing");
  if (components !== undefined && !Number.isSafeInteger(components)) throw new RangeError("Usage total exceeds a safe integer");
  if (totalTokens !== undefined && !Number.isSafeInteger(totalTokens)) throw new RangeError("Usage total exceeds a safe integer");
  if (usage.totalTokens !== undefined && components !== undefined && totalTokens! < components) throw new RangeError("Usage totalTokens is smaller than its included components");
  return { ...(totalTokens === undefined ? {} : { totalTokens }), complete: missing.length === 0, missingReasons: missing };
}

export function aggregateUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (current === undefined && next === undefined) return undefined;
  if (current === undefined) return next === undefined ? undefined : structuredClone(next);
  if (next === undefined) return { ...structuredClone(current), completeness: { status: "partial", reason: "response-usage-missing" } };
  const currentTotals = resolveUsageTotals(current);
  const nextTotals = resolveUsageTotals(next);
  const usage: Usage = {};
  for (const field of ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "reasoningTokens"] as const) {
    if (current[field] !== undefined || next[field] !== undefined) usage[field] = (current[field] ?? 0) + (next[field] ?? 0);
  }
  const relations: NonNullable<Usage["tokenRelations"]> = {};
  for (const [field, key] of detailFields) {
    if (usage[field] === undefined) continue;
    const left = current[field] === undefined || current[field] === 0 ? undefined : current.tokenRelations?.[key] ?? "unknown";
    const right = next[field] === undefined || next[field] === 0 ? undefined : next.tokenRelations?.[key] ?? "unknown";
    relations[key] = left === undefined ? right ?? "unknown" : right === undefined || left === right ? left : "unknown";
  }
  if (Object.keys(relations).length > 0) usage.tokenRelations = relations;
  if (current.totalTokens !== undefined || next.totalTokens !== undefined) {
    const providerTotal = (source: Usage, totals: UsageTotals) => source.totalTokens ?? (totals.totalTokens === undefined ? 0 : totals.totalTokens - detailFields.reduce((sum, [field, key]) => sum + (source.tokenRelations?.[key] === "none" ? source[field] ?? 0 : 0), 0)
      - (source.items ?? []).reduce((sum, item) => sum + (item.unit === "tokens" && item.includedIn === "none" ? item.quantity : 0), 0));
    usage.totalTokens = providerTotal(current, currentTotals) + providerTotal(next, nextTotals);
  }
  const items = new Map<string, NonNullable<Usage["items"]>[number]>();
  for (const item of [...current.items ?? [], ...next.items ?? []]) {
    const existing = items.get(item.id);
    if (existing !== undefined && existing.unit !== item.unit) throw new TypeError(`Usage item ${item.id} has inconsistent units`);
    items.set(item.id, existing === undefined ? { ...item } : { ...item, quantity: existing.quantity + item.quantity, includedIn: existing.includedIn === item.includedIn ? item.includedIn : "unknown" });
  }
  if (items.size > 0) usage.items = [...items.values()];
  if (current.reportedCost !== undefined && next.reportedCost !== undefined && current.reportedCost.currency === next.reportedCost.currency) {
    usage.reportedCost = { amount: current.reportedCost.amount + next.reportedCost.amount, currency: current.reportedCost.currency,
      source: current.reportedCost.source === next.reportedCost.source ? current.reportedCost.source : "multiple-providers" };
  }
  if (!currentTotals.complete || !nextTotals.complete) usage.completeness = { status: "partial", reason: "response-usage-incomplete" };
  validateUsage(usage);
  return usage;
}

export function priceUsage(usage?: Usage, prices?: TokenPriceSchedule | TokenPrices, pricer?: UsagePricer): UsageCost {
  const schedule = resolvePriceSchedule(prices);
  if (usage !== undefined) resolveUsageTotals(usage);
  const result = pricer === undefined ? calculateUsageCost(usage, schedule) : pricer(usage, schedule);
  object(result, "usage cost");
  return validateUsageCost(result.kind === "estimated" && schedule !== undefined
    ? { pricingId: schedule.id, pricingVersion: schedule.version, source: schedule.source, effectiveAt: schedule.effectiveAt, ...result }
    : result);
}

export function validateUsageCost(result: UsageCost): UsageCost {
  object(result, "usage cost"); currency(result.currency);
  if (Object.keys(result).some(key => !["amount", "currency", "kind", "complete", "missingReasons", "pricingId", "pricingVersion", "source", "effectiveAt"].includes(key))) throw new TypeError("Unknown usage cost field");
  if (result.amount !== undefined) nonnegative(result.amount, "usage cost amount");
  if (!["estimated", "provider"].includes(result.kind) || typeof result.complete !== "boolean" || !Array.isArray(result.missingReasons) || result.missingReasons.length > 64 || result.missingReasons.some(reason => typeof reason !== "string" || reason.length > 256)) throw new TypeError("Invalid usage cost result");
  for (const key of ["pricingId", "pricingVersion", "source", "effectiveAt"] as const) if (result[key] !== undefined) boundedText(result[key], `usage cost ${key}`);
  if (result.effectiveAt !== undefined && !Number.isFinite(Date.parse(result.effectiveAt))) throw new RangeError("usage cost effectiveAt must be a valid timestamp");
  if (result.complete && (result.amount === undefined || result.missingReasons.length !== 0)) throw new TypeError("Complete usage cost requires an amount and no missing reasons");
  return Object.freeze({ ...result, missingReasons: Object.freeze([...result.missingReasons]) });
}

function calculateUsageCost(usage: Usage | undefined, pricing: Readonly<TokenPriceSchedule> | undefined): UsageCost {
  if (usage?.reportedCost !== undefined) return { ...usage.reportedCost, kind: "provider", complete: true, missingReasons: [] };
  const metadata = pricing === undefined ? {} : { pricingId: pricing.id, pricingVersion: pricing.version, source: pricing.source, effectiveAt: pricing.effectiveAt };
  const missing: string[] = [];
  const result = { currency: pricing?.currency ?? "USD", kind: "estimated" as const, ...metadata };
  if (usage === undefined) return { ...result, complete: false, missingReasons: ["usage-missing"] };
  if (pricing === undefined) return { ...result, complete: false, missingReasons: ["pricing-missing"] };
  if (usage.completeness !== undefined && usage.completeness.status !== "complete") missing.push(usage.completeness.reason ?? `usage-${usage.completeness.status}`);
  const quantities: Record<"input" | "output" | "cachedRead" | "cachedWrite" | "reasoning", number | undefined> = {
    input: usage.inputTokens, output: usage.outputTokens, cachedRead: usage.cachedReadTokens, cachedWrite: usage.cachedWriteTokens, reasoning: usage.reasoningTokens,
  };
  let itemCost = 0;
  for (const item of usage.items ?? []) {
    if (item.quantity === 0) continue;
    const rate = pricing.items?.[item.id];
    if (item.includedIn === "unknown") { missing.push(`item-${item.id}-relation-unknown`); continue; }
    if (item.includedIn === "cost") { missing.push(`item-${item.id}-reported-cost-missing`); continue; }
    const containing = item.includedIn === "none" ? undefined : item.includedIn;
    if (containing !== undefined && rate === undefined) continue;
    if (rate === undefined || rate.unit !== item.unit) { missing.push(`item-${item.id}-price-missing`); continue; }
    if (containing !== undefined) {
      if (item.unit !== "tokens") throw new TypeError("A token subset must use the tokens unit");
      const tokens = quantities[containing];
      if (tokens === undefined) { missing.push(`item-${item.id}-containing-usage-missing`); continue; }
      quantities[containing] = tokens - item.quantity;
      if (containing !== "input" && containing !== "output") {
        const relation = usage.tokenRelations?.[containing];
        if (relation === "input" && quantities.input !== undefined) quantities.input -= item.quantity;
        if (relation === "output" && quantities.output !== undefined) quantities.output -= item.quantity;
      }
    }
    itemCost += item.quantity * rate.perUnit;
  }
  let input = quantities.input;
  let output = quantities.output;
  if (input === undefined) missing.push("input-tokens-missing");
  if (output === undefined) missing.push("output-tokens-missing");
  let detailTokenCost = 0;
  for (const [field, relationKey, priceKey] of detailFields) {
    const tokens = quantities[relationKey];
    if (tokens === undefined || tokens === 0) continue;
    const relation = usage.tokenRelations?.[relationKey] ?? "unknown";
    if (relation === "unknown") { missing.push(`${field}-relation-unknown`); continue; }
    const rate = pricing[priceKey];
    if (relation === "input" && rate === undefined) continue;
    if (relation === "output" && rate === undefined) continue;
    if (rate === undefined) { missing.push(`${field}-price-missing`); continue; }
    if (relation === "input" && input !== undefined) input -= tokens;
    if (relation === "output" && output !== undefined) output -= tokens;
    detailTokenCost += tokens * rate;
  }
  if ((input !== undefined && input < 0) || (output !== undefined && output < 0)) throw new RangeError("Usage detail subsets exceed their containing token count");
  if (Object.values(quantities).some(value => value !== undefined && value < 0)) throw new RangeError("Usage item subsets exceed their containing token count");
  const amount = input === undefined || output === undefined ? undefined : (input * pricing.inputPerMillion + output * pricing.outputPerMillion + detailTokenCost) / 1_000_000 + itemCost;
  return { ...result, ...(amount === undefined ? {} : { amount }), complete: missing.length === 0, missingReasons: missing };
}

function validateUsage(usage: Usage): void {
  object(usage, "usage");
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "cachedReadTokens", "cachedWriteTokens", "reasoningTokens"] as const) {
    if (usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || usage[field]! < 0)) throw new RangeError(`usage.${field} must be a non-negative safe integer`);
  }
  if (usage.tokenRelations !== undefined) {
    object(usage.tokenRelations, "usage.tokenRelations");
    for (const [key, relation] of Object.entries(usage.tokenRelations)) {
      if (!["cachedRead", "cachedWrite", "reasoning"].includes(key) || !["input", "output", "total", "none", "unknown"].includes(relation as UsageTokenRelation)) throw new TypeError("Invalid usage token relationship");
    }
    for (const [field, key] of detailFields) {
      const relation = usage.tokenRelations[key];
      if (usage[field] !== undefined && relation === "input" && usage.inputTokens !== undefined && usage[field]! > usage.inputTokens) throw new RangeError(`${field} exceeds inputTokens`);
      if (usage[field] !== undefined && relation === "output" && usage.outputTokens !== undefined && usage[field]! > usage.outputTokens) throw new RangeError(`${field} exceeds outputTokens`);
    }
  }
  if (usage.completeness !== undefined) {
    object(usage.completeness, "usage.completeness");
    if (!["complete", "partial", "unavailable"].includes(usage.completeness.status)) throw new TypeError("Invalid usage completeness");
    if (usage.completeness.reason !== undefined) boundedText(usage.completeness.reason, "usage completeness reason");
  }
  if (usage.reportedCost !== undefined) {
    object(usage.reportedCost, "usage.reportedCost"); nonnegative(usage.reportedCost.amount, "reported cost");
    currency(usage.reportedCost.currency); boundedText(usage.reportedCost.source, "reported cost source");
  }
  if (usage.items !== undefined) {
    if (!Array.isArray(usage.items) || usage.items.length > 64) throw new RangeError("usage.items must be an array of at most 64 entries");
    const ids = new Set<string>();
    const subsets = new Map<string, number>();
    for (const item of usage.items as readonly UsageItem[]) {
      object(item, "usage item"); boundedText(item.id, "usage item id"); boundedText(item.unit, "usage item unit"); nonnegative(item.quantity, "usage item quantity");
      if (ids.has(item.id) || !["input", "output", "cachedRead", "cachedWrite", "reasoning", "cost", "none", "unknown"].includes(item.includedIn)) throw new TypeError("Invalid or duplicate usage item");
      if (["input", "output", "cachedRead", "cachedWrite", "reasoning"].includes(item.includedIn) && (item.unit !== "tokens" || !Number.isSafeInteger(item.quantity))) throw new TypeError("A token subset must use an integer tokens quantity");
      if (["input", "output", "cachedRead", "cachedWrite", "reasoning"].includes(item.includedIn)) {
        subsets.set(item.includedIn, (subsets.get(item.includedIn) ?? 0) + item.quantity);
      }
      ids.add(item.id);
    }
    const quantities = { input: usage.inputTokens, output: usage.outputTokens, cachedRead: usage.cachedReadTokens, cachedWrite: usage.cachedWriteTokens, reasoning: usage.reasoningTokens };
    for (const [key, total] of subsets) {
      const containing = quantities[key as keyof typeof quantities];
      if (containing !== undefined && total > containing) throw new RangeError(`Usage item subsets exceed ${key} token count`);
    }
  }
}

function object(value: unknown, field: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function nonnegative(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and non-negative`);
}

function boundedText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new TypeError(`${field} must be a non-empty string of at most 256 characters`);
}

function currency(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new TypeError("Currency must be an uppercase ISO 4217 code");
}
