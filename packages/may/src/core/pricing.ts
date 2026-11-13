import { omitUndefined } from "./omit-undefined.js";
import type { Usage } from "./types.js";
import { boundedText, currency, detailFields, nonnegative, object } from "./usage-checks.js";
import { resolveUsageTotals } from "./usage-totals.js";

/** @experimental */
export interface TokenPrices {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cachedReadUsdPerMillion?: number;
  readonly cachedWriteUsdPerMillion?: number;
  readonly reasoningUsdPerMillion?: number;
}

/** @experimental */
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

/** @experimental */
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

/** @experimental */
export type UsagePricer = (
  usage: Readonly<Usage> | undefined,
  pricing: Readonly<TokenPriceSchedule> | undefined,
) => UsageCost;

/** @experimental */
export function validateTokenPrices(prices: TokenPrices): void {
  object(prices, "tokenPrices");
  const fields = [
    "inputUsdPerMillion",
    "outputUsdPerMillion",
    "cachedReadUsdPerMillion",
    "cachedWriteUsdPerMillion",
    "reasoningUsdPerMillion",
  ];
  for (const [key, value] of Object.entries(prices)) {
    if (!fields.includes(key)) throw new TypeError(`Unknown tokenPrices field: ${key}`);
    nonnegative(value, `tokenPrices.${key}`);
  }
  nonnegative(prices.inputUsdPerMillion, "tokenPrices.inputUsdPerMillion");
  nonnegative(prices.outputUsdPerMillion, "tokenPrices.outputUsdPerMillion");
}

/** @experimental */
export function resolvePriceSchedule(
  value?: TokenPriceSchedule | TokenPrices,
): Readonly<TokenPriceSchedule> | undefined {
  if (value === undefined) return undefined;
  object(value, "pricing");
  if ("inputUsdPerMillion" in value) {
    validateTokenPrices(value);
    return Object.freeze(
      omitUndefined({
        id: "legacy-token-prices",
        version: "1",
        currency: "USD",
        source: "host",
        effectiveAt: "1970-01-01T00:00:00.000Z",
        inputPerMillion: value.inputUsdPerMillion,
        outputPerMillion: value.outputUsdPerMillion,
        cachedReadPerMillion: value.cachedReadUsdPerMillion,
        cachedWritePerMillion: value.cachedWriteUsdPerMillion,
        reasoningPerMillion: value.reasoningUsdPerMillion,
      }),
    );
  }
  const fields = [
    "id",
    "version",
    "currency",
    "source",
    "effectiveAt",
    "inputPerMillion",
    "outputPerMillion",
    "cachedReadPerMillion",
    "cachedWritePerMillion",
    "reasoningPerMillion",
    "items",
  ];
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(`Unknown pricing field: ${key}`);
  for (const key of ["id", "version", "source", "effectiveAt"] as const) boundedText(value[key], `pricing.${key}`);
  currency(value.currency);
  if (!Number.isFinite(Date.parse(value.effectiveAt)))
    throw new RangeError("pricing.effectiveAt must be a valid timestamp");
  nonnegative(value.inputPerMillion, "pricing.inputPerMillion");
  nonnegative(value.outputPerMillion, "pricing.outputPerMillion");
  for (const key of ["cachedReadPerMillion", "cachedWritePerMillion", "reasoningPerMillion"] as const)
    if (value[key] !== undefined) nonnegative(value[key], `pricing.${key}`);
  if (value.items !== undefined) {
    object(value.items, "pricing.items");
    if (Object.keys(value.items).length > 64) throw new RangeError("pricing.items exceeds 64 entries");
    for (const [id, rate] of Object.entries(value.items)) {
      boundedText(id, "pricing item id");
      object(rate, `pricing.items.${id}`);
      if (Object.keys(rate).some((key) => !["unit", "perUnit"].includes(key)))
        throw new TypeError("Unknown pricing item field");
      boundedText(rate.unit, "pricing item unit");
      nonnegative(rate.perUnit, "pricing item rate");
    }
  }
  return Object.freeze({
    ...value,
    ...(value.items === undefined
      ? {}
      : {
          items: Object.freeze(
            Object.fromEntries(Object.entries(value.items).map(([id, rate]) => [id, Object.freeze({ ...rate })])),
          ),
        }),
  });
}

/** @experimental */
export function priceUsage(usage?: Usage, prices?: TokenPriceSchedule | TokenPrices, pricer?: UsagePricer): UsageCost {
  const schedule = resolvePriceSchedule(prices);
  if (usage !== undefined) resolveUsageTotals(usage);
  const result = pricer === undefined ? calculateUsageCost(usage, schedule) : pricer(usage, schedule);
  object(result, "usage cost");
  return validateUsageCost(
    result.kind === "estimated" && schedule !== undefined
      ? {
          pricingId: schedule.id,
          pricingVersion: schedule.version,
          source: schedule.source,
          effectiveAt: schedule.effectiveAt,
          ...result,
        }
      : result,
  );
}

/** @experimental */
export function validateUsageCost(result: UsageCost): UsageCost {
  object(result, "usage cost");
  currency(result.currency);
  if (
    Object.keys(result).some(
      (key) =>
        ![
          "amount",
          "currency",
          "kind",
          "complete",
          "missingReasons",
          "pricingId",
          "pricingVersion",
          "source",
          "effectiveAt",
        ].includes(key),
    )
  )
    throw new TypeError("Unknown usage cost field");
  if (result.amount !== undefined) nonnegative(result.amount, "usage cost amount");
  if (
    !["estimated", "provider"].includes(result.kind) ||
    typeof result.complete !== "boolean" ||
    !Array.isArray(result.missingReasons) ||
    result.missingReasons.length > 64 ||
    result.missingReasons.some((reason) => typeof reason !== "string" || reason.length > 256)
  )
    throw new TypeError("Invalid usage cost result");
  for (const key of ["pricingId", "pricingVersion", "source", "effectiveAt"] as const)
    if (result[key] !== undefined) boundedText(result[key], `usage cost ${key}`);
  if (result.effectiveAt !== undefined && !Number.isFinite(Date.parse(result.effectiveAt)))
    throw new RangeError("usage cost effectiveAt must be a valid timestamp");
  if (result.complete && (result.amount === undefined || result.missingReasons.length !== 0))
    throw new TypeError("Complete usage cost requires an amount and no missing reasons");
  return Object.freeze({ ...result, missingReasons: Object.freeze([...result.missingReasons]) });
}

function calculateUsageCost(usage: Usage | undefined, pricing: Readonly<TokenPriceSchedule> | undefined): UsageCost {
  if (usage?.reportedCost !== undefined)
    return { ...usage.reportedCost, kind: "provider", complete: true, missingReasons: [] };
  const metadata =
    pricing === undefined
      ? {}
      : {
          pricingId: pricing.id,
          pricingVersion: pricing.version,
          source: pricing.source,
          effectiveAt: pricing.effectiveAt,
        };
  const missing: string[] = [];
  const result = { currency: pricing?.currency ?? "USD", kind: "estimated" as const, ...metadata };
  if (usage === undefined) return { ...result, complete: false, missingReasons: ["usage-missing"] };
  if (pricing === undefined) return { ...result, complete: false, missingReasons: ["pricing-missing"] };
  if (usage.completeness !== undefined && usage.completeness.status !== "complete")
    missing.push(usage.completeness.reason ?? `usage-${usage.completeness.status}`);
  const quantities: Record<"input" | "output" | "cachedRead" | "cachedWrite" | "reasoning", number | undefined> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedRead: usage.cachedReadTokens,
    cachedWrite: usage.cachedWriteTokens,
    reasoning: usage.reasoningTokens,
  };
  let itemCost = 0;
  for (const item of usage.items ?? []) {
    if (item.quantity === 0) continue;
    const rate = pricing.items?.[item.id];
    if (item.includedIn === "unknown") {
      missing.push(`item-${item.id}-relation-unknown`);
      continue;
    }
    if (item.includedIn === "cost") {
      missing.push(`item-${item.id}-reported-cost-missing`);
      continue;
    }
    const containing = item.includedIn === "none" ? undefined : item.includedIn;
    if (containing !== undefined && rate === undefined) continue;
    if (rate === undefined || rate.unit !== item.unit) {
      missing.push(`item-${item.id}-price-missing`);
      continue;
    }
    if (containing !== undefined) {
      if (item.unit !== "tokens") throw new TypeError("A token subset must use the tokens unit");
      const tokens = quantities[containing];
      if (tokens === undefined) {
        missing.push(`item-${item.id}-containing-usage-missing`);
        continue;
      }
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
    if (relation === "unknown") {
      missing.push(`${field}-relation-unknown`);
      continue;
    }
    const rate = pricing[priceKey];
    if (relation === "input" && rate === undefined) continue;
    if (relation === "output" && rate === undefined) continue;
    if (rate === undefined) {
      missing.push(`${field}-price-missing`);
      continue;
    }
    if (relation === "input" && input !== undefined) input -= tokens;
    if (relation === "output" && output !== undefined) output -= tokens;
    detailTokenCost += tokens * rate;
  }
  if ((input !== undefined && input < 0) || (output !== undefined && output < 0))
    throw new RangeError("Usage detail subsets exceed their containing token count");
  if (Object.values(quantities).some((value) => value !== undefined && value < 0))
    throw new RangeError("Usage item subsets exceed their containing token count");
  const amount =
    input === undefined || output === undefined
      ? undefined
      : (input * pricing.inputPerMillion + output * pricing.outputPerMillion + detailTokenCost) / 1_000_000 + itemCost;
  return { ...result, ...omitUndefined({ amount }), complete: missing.length === 0, missingReasons: missing };
}
