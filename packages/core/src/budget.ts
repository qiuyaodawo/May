import { MayError } from "./errors.js";
import type { Usage } from "./types.js";
import { priceUsage, resolvePriceSchedule, resolveUsageTotals, validateTokenPrices, validateUsageCost, type TokenPrices, type TokenPriceSchedule, type UsageCost, type UsagePricer } from "./pricing.js";

/** Limits for one Run/continue. Token and cost limits are checked at response boundaries. */
export interface RunBudget {
  readonly maxDurationMs?: number;
  readonly maxSteps?: number;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
  readonly tokenPrices?: TokenPrices;
  readonly pricing?: TokenPriceSchedule;
  readonly usagePricer?: UsagePricer;
}

export interface RunBudgetSnapshot {
  readonly elapsedMs: number;
  readonly steps: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly usageComplete: boolean;
  readonly costComplete?: boolean;
  readonly costKind?: "estimated" | "provider" | "mixed";
  readonly latestCost?: UsageCost;
}

export class RunBudgetExceededError extends MayError {
  constructor(readonly dimension: string, readonly limit: number, readonly consumed: number) {
    super("RUN_BUDGET_EXCEEDED", `Run budget exceeded: ${dimension} (limit ${limit}, consumed ${consumed})`);
  }
}

/** Validate and snapshot caller-owned limits. Overrides may only tighten defaults. */
export function resolveRunBudget(defaults?: RunBudget, override?: RunBudget): Readonly<RunBudget> {
  for (const budget of [defaults, override]) {
    if (budget === undefined) continue;
    if (typeof budget !== "object" || budget === null || Array.isArray(budget)) throw new TypeError("runBudget must be an object");
    for (const [key, value] of Object.entries(budget)) {
      if (["tokenPrices", "pricing", "usagePricer"].includes(key)) continue;
      if (!["maxDurationMs", "maxSteps", "maxModelCalls", "maxToolCalls", "maxTotalTokens", "maxCostUsd"].includes(key)) throw new TypeError(`Unknown runBudget field: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key !== "maxCostUsd" && !Number.isSafeInteger(value))) throw new RangeError(`${key} must be a positive ${key === "maxCostUsd" ? "finite number" : "safe integer"}`);
      if (key === "maxDurationMs" && value > 2_147_483_647) throw new RangeError("maxDurationMs exceeds the timer limit");
    }
    if (budget.tokenPrices !== undefined) {
      validateTokenPrices(budget.tokenPrices);
    }
    if (budget.pricing !== undefined) resolvePriceSchedule(budget.pricing);
    if (budget.tokenPrices !== undefined && budget.pricing !== undefined) throw new TypeError("Configure pricing or tokenPrices independently");
    if (budget.usagePricer !== undefined && typeof budget.usagePricer !== "function") throw new TypeError("usagePricer must be a function");
  }
  const result = { ...defaults, ...override };
  for (const key of ["maxDurationMs", "maxSteps", "maxModelCalls", "maxToolCalls", "maxTotalTokens", "maxCostUsd"] as const) {
    if (defaults?.[key] !== undefined && override?.[key] !== undefined) result[key] = Math.min(defaults[key], override[key]);
  }
  const defaultPrices = resolvePriceSchedule(defaults?.pricing ?? defaults?.tokenPrices);
  const overridePrices = resolvePriceSchedule(override?.pricing ?? override?.tokenPrices);
  if (defaultPrices !== undefined && overridePrices !== undefined && priceFingerprint(defaultPrices) !== priceFingerprint(overridePrices)) throw new Error("Per-run pricing cannot override agent prices");
  if (defaults?.usagePricer !== undefined && override?.usagePricer !== undefined && defaults.usagePricer !== override.usagePricer) throw new Error("Per-run usagePricer cannot override agent pricing");
  if (defaults?.pricing !== undefined && override?.tokenPrices !== undefined) delete result.tokenPrices;
  if (defaults?.tokenPrices !== undefined && override?.pricing !== undefined) delete result.tokenPrices;
  if (result.maxCostUsd !== undefined && result.tokenPrices === undefined && result.pricing === undefined && result.usagePricer === undefined) throw new Error("maxCostUsd requires explicit pricing, tokenPrices, or usagePricer");
  const schedule = resolvePriceSchedule(result.pricing ?? result.tokenPrices);
  if (result.maxCostUsd !== undefined && schedule !== undefined && schedule.currency !== "USD") throw new Error("maxCostUsd requires USD pricing");
  if (result.tokenPrices) result.tokenPrices = Object.freeze({ ...result.tokenPrices });
  if (result.pricing) result.pricing = resolvePriceSchedule(result.pricing) as TokenPriceSchedule;
  return Object.freeze(result);
}

function priceFingerprint(pricing: Readonly<TokenPriceSchedule>): string {
  return JSON.stringify([pricing.id, pricing.version, pricing.currency, pricing.source, pricing.effectiveAt,
    pricing.inputPerMillion, pricing.outputPerMillion, pricing.cachedReadPerMillion, pricing.cachedWritePerMillion, pricing.reasoningPerMillion,
    Object.entries(pricing.items ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, rate]) => [id, rate.unit, rate.perUnit])]);
}

export class RunBudgetMeter {
  private readonly startedAt = Date.now();
  private steps = 0;
  private modelCalls = 0;
  private toolCalls = 0;
  private totalTokens = 0;
  private costUsd = 0;
  private usageComplete = true;
  private costComplete = true;
  private costKind: "estimated" | "provider" | "mixed" | undefined;
  private latestCost: UsageCost | undefined;
  constructor(readonly limits: Readonly<RunBudget>) {}

  snapshot(): RunBudgetSnapshot {
    return { elapsedMs: Math.max(0, Date.now() - this.startedAt), steps: this.steps,
      modelCalls: this.modelCalls, toolCalls: this.toolCalls, totalTokens: this.totalTokens,
      costUsd: this.costUsd, usageComplete: this.usageComplete, costComplete: this.costComplete,
      ...(this.costKind === undefined ? {} : { costKind: this.costKind }),
      ...(this.latestCost === undefined ? {} : { latestCost: this.latestCost }) };
  }

  checkTime(): void {
    const elapsed = this.snapshot().elapsedMs;
    if (this.limits.maxDurationMs !== undefined && elapsed >= this.limits.maxDurationMs) throw new RunBudgetExceededError("durationMs", this.limits.maxDurationMs, elapsed);
  }

  startModel(step: number): void {
    this.checkTime();
    this.check("steps", this.limits.maxSteps, step);
    this.check("modelCalls", this.limits.maxModelCalls, this.modelCalls + 1);
    if (this.limits.maxTotalTokens !== undefined && this.totalTokens >= this.limits.maxTotalTokens) throw new RunBudgetExceededError("totalTokens", this.limits.maxTotalTokens, this.totalTokens);
    if (this.limits.maxCostUsd !== undefined && this.costUsd >= this.limits.maxCostUsd) throw new RunBudgetExceededError("costUsd", this.limits.maxCostUsd, this.costUsd);
    this.steps = step;
    this.modelCalls++;
  }

  reserveTools(count: number): void {
    this.checkTime();
    if (this.limits.maxTotalTokens !== undefined && this.totalTokens >= this.limits.maxTotalTokens) throw new RunBudgetExceededError("totalTokens", this.limits.maxTotalTokens, this.totalTokens);
    if (this.limits.maxCostUsd !== undefined && this.costUsd >= this.limits.maxCostUsd) throw new RunBudgetExceededError("costUsd", this.limits.maxCostUsd, this.costUsd);
    this.check("toolCalls", this.limits.maxToolCalls, this.toolCalls + count);
    this.toolCalls += count;
  }

  recordUsage(usage?: Usage, preparedCost?: UsageCost): void {
    const totals = resolveUsageTotals(usage);
    this.usageComplete &&= totals.complete;
    if (totals.totalTokens !== undefined) this.totalTokens += totals.totalTokens;
    try {
      this.latestCost = preparedCost === undefined ? priceUsage(usage, this.limits.pricing ?? this.limits.tokenPrices, this.limits.usagePricer) : validateUsageCost(preparedCost);
    } catch (error) {
      this.latestCost = undefined;
      this.costComplete = false;
      throw error;
    }
    const priced = this.latestCost.complete && this.latestCost.currency === "USD" && this.latestCost.amount !== undefined;
    this.costComplete &&= priced;
    if (priced) {
      this.costUsd += this.latestCost.amount!;
      this.costKind = this.costKind === undefined ? this.latestCost.kind : this.costKind === this.latestCost.kind ? this.costKind : "mixed";
    }
    if (!Number.isSafeInteger(this.totalTokens) || !Number.isFinite(this.costUsd)) throw new RangeError("Run budget usage exceeds the numeric range");
    if ((this.limits.maxTotalTokens !== undefined && !totals.complete) || (this.limits.maxCostUsd !== undefined && !priced)) {
      throw new MayError("RUN_BUDGET_USAGE_UNAVAILABLE", "The model did not report the usage required to enforce this run budget");
    }
    this.check("totalTokens", this.limits.maxTotalTokens, this.totalTokens);
    this.check("costUsd", this.limits.maxCostUsd, this.costUsd);
    this.checkTime();
  }

  private check(dimension: string, limit: number | undefined, consumed: number): void {
    if (limit !== undefined && consumed > limit) throw new RunBudgetExceededError(dimension, limit, consumed);
  }
}
