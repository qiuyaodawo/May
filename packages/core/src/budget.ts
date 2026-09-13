import { MayError } from "./errors.js";
import type { Usage } from "./types.js";

/** Limits for one Run/continue. Token and cost limits are checked at response boundaries. */
export interface RunBudget {
  readonly maxDurationMs?: number;
  readonly maxSteps?: number;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
  readonly tokenPrices?: { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };
}

export interface RunBudgetSnapshot {
  readonly elapsedMs: number;
  readonly steps: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly usageComplete: boolean;
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
      if (key === "tokenPrices") continue;
      if (!["maxDurationMs", "maxSteps", "maxModelCalls", "maxToolCalls", "maxTotalTokens", "maxCostUsd"].includes(key)) throw new TypeError(`Unknown runBudget field: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key !== "maxCostUsd" && !Number.isSafeInteger(value))) throw new RangeError(`${key} must be a positive ${key === "maxCostUsd" ? "finite number" : "safe integer"}`);
      if (key === "maxDurationMs" && value > 2_147_483_647) throw new RangeError("maxDurationMs exceeds the timer limit");
    }
    if (budget.tokenPrices !== undefined) {
      const prices = budget.tokenPrices;
      if (typeof prices !== "object" || prices === null || Array.isArray(prices) ||
        Object.keys(prices).some((key) => !["inputUsdPerMillion", "outputUsdPerMillion"].includes(key)) ||
        [prices.inputUsdPerMillion, prices.outputUsdPerMillion].some((price) => typeof price !== "number" || !Number.isFinite(price) || price < 0)) throw new RangeError("tokenPrices requires finite non-negative input/output USD per million");
    }
  }
  const result = { ...defaults, ...override };
  for (const key of ["maxDurationMs", "maxSteps", "maxModelCalls", "maxToolCalls", "maxTotalTokens", "maxCostUsd"] as const) {
    if (defaults?.[key] !== undefined && override?.[key] !== undefined) result[key] = Math.min(defaults[key], override[key]);
  }
  if (defaults?.tokenPrices && override?.tokenPrices && (defaults.tokenPrices.inputUsdPerMillion !== override.tokenPrices.inputUsdPerMillion || defaults.tokenPrices.outputUsdPerMillion !== override.tokenPrices.outputUsdPerMillion)) throw new Error("Per-run tokenPrices cannot override agent prices");
  if (result.maxCostUsd !== undefined && result.tokenPrices === undefined) throw new Error("maxCostUsd requires explicit tokenPrices");
  if (result.tokenPrices) result.tokenPrices = Object.freeze({ ...result.tokenPrices });
  return Object.freeze(result);
}

export class RunBudgetMeter {
  private readonly startedAt = Date.now();
  private steps = 0;
  private modelCalls = 0;
  private toolCalls = 0;
  private totalTokens = 0;
  private costUsd = 0;
  private usageComplete = true;
  constructor(readonly limits: Readonly<RunBudget>) {}

  snapshot(): RunBudgetSnapshot {
    return { elapsedMs: Math.max(0, Date.now() - this.startedAt), steps: this.steps,
      modelCalls: this.modelCalls, toolCalls: this.toolCalls, totalTokens: this.totalTokens,
      costUsd: this.costUsd, usageComplete: this.usageComplete };
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

  recordUsage(usage?: Usage): void {
    const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
    const total = valid(usage?.totalTokens) ? usage.totalTokens
      : valid(usage?.inputTokens) && valid(usage?.outputTokens) ? usage.inputTokens + usage.outputTokens : undefined;
    if (total === undefined) this.usageComplete = false;
    else this.totalTokens += total;
    const prices = this.limits.tokenPrices;
    const priced = prices !== undefined && valid(usage?.inputTokens) && valid(usage?.outputTokens);
    if (priced) this.costUsd += (usage.inputTokens! * prices.inputUsdPerMillion + usage.outputTokens! * prices.outputUsdPerMillion) / 1_000_000;
    if ((this.limits.maxTotalTokens !== undefined && total === undefined) || (this.limits.maxCostUsd !== undefined && !priced)) {
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
