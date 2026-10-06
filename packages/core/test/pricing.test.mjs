import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, priceUsage, resolvePriceSchedule, resolveUsageTotals, resolveRunBudget, RunBudgetMeter } from "../dist/index.js";

const pricing = { id: "host-model-prices", version: "2026-10-05", source: "host configuration", effectiveAt: "2026-10-05T00:00:00Z", currency: "USD",
  inputPerMillion: 2, outputPerMillion: 8, cachedReadPerMillion: 0.2, cachedWritePerMillion: 3, reasoningPerMillion: 4 };

test("prices included cache and reasoning subsets once and preserves price identity", () => {
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedReadTokens: 80, reasoningTokens: 30,
    tokenRelations: { cachedRead: "input", reasoning: "output" } };
  const cost = priceUsage(usage, pricing);
  assert.equal(cost.amount, (20 * 2 + 80 * 0.2 + 20 * 8 + 30 * 4) / 1_000_000);
  assert.equal(cost.complete, true);
  assert.equal(cost.kind, "estimated");
  assert.equal(cost.pricingVersion, "2026-10-05");
  assert.equal(resolveUsageTotals(usage).totalTokens, 150);
  assert.equal(priceUsage(usage, { inputUsdPerMillion: 2, outputUsdPerMillion: 8 }).amount, 0.0006);
});

test("accounts separately reported cache tokens and additional billable units", () => {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 45, cachedReadTokens: 20, cachedWriteTokens: 10,
    tokenRelations: { cachedRead: "total", cachedWrite: "total" }, items: [{ id: "search", quantity: 2, unit: "requests", includedIn: "none" }] };
  const cost = priceUsage(usage, { ...pricing, items: { search: { unit: "requests", perUnit: 0.01 } } });
  assert.equal(cost.amount, 0.020094);
  assert.equal(cost.complete, true);
  assert.equal(resolveUsageTotals(usage).totalTokens, 45);
  assert.equal(resolveUsageTotals({ ...usage, totalTokens: undefined }).totalTokens, 45);
  assert.equal(resolveUsageTotals({ inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 4, tokenRelations: { reasoning: "none" } }).totalTokens, 7);
});

test("preserves unavailable accounting and rejects malformed measurements", () => {
  assert.equal(priceUsage(undefined, pricing).amount, undefined);
  assert.deepEqual(priceUsage({ inputTokens: 1, outputTokens: 1, cachedReadTokens: 1 }, pricing).missingReasons, ["cachedReadTokens-relation-unknown"]);
  assert.equal(priceUsage({ inputTokens: 1, outputTokens: 1, cachedWriteTokens: 1, tokenRelations: { cachedWrite: "total" } }, { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }).complete, false);
  assert.throws(() => priceUsage({ inputTokens: -1, outputTokens: 0 }, pricing), /safe integer/);
  assert.throws(() => priceUsage({ inputTokens: 1, outputTokens: 0, cachedReadTokens: 2, tokenRelations: { cachedRead: "input" } }, pricing), /exceeds inputTokens/);
  assert.throws(() => resolveUsageTotals({ inputTokens: 5, outputTokens: 5, totalTokens: 2 }), /smaller/);
  assert.throws(() => resolvePriceSchedule({ ...pricing, cachedReadPerMillion: Infinity }), /finite/);
});

test("total-only details require disjoint input and output accounting", () => {
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 170, cachedReadTokens: 20, tokenRelations: { cachedRead: "total" } };
  assert.equal(priceUsage(usage, pricing).amount, (100 * 2 + 50 * 8 + 20 * 0.2) / 1_000_000);
  assert.equal(priceUsage(usage, pricing).complete, true);
  assert.throws(() => priceUsage({ ...usage, totalTokens: 150 }, pricing), /smaller than its included components/);
  const ambiguous = { ...usage, totalTokens: 150, tokenRelations: { cachedRead: "unknown" } };
  assert.equal(priceUsage(ambiguous, pricing).complete, false);
  assert.deepEqual(priceUsage(ambiguous, pricing).missingReasons, ["cachedReadTokens-relation-unknown"]);
});

test("prices additional token subsets without adding their containing charge twice", () => {
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedWriteTokens: 40, tokenRelations: { cachedWrite: "input" },
    items: [{ id: "cache-write-hour", quantity: 30, unit: "tokens", includedIn: "cachedWrite" }, { id: "audio-output", quantity: 10, unit: "tokens", includedIn: "output" }] };
  const cost = priceUsage(usage, { ...pricing, items: { "cache-write-hour": { unit: "tokens", perUnit: 0.000006 }, "audio-output": { unit: "tokens", perUnit: 0.00002 } } });
  assert.ok(Math.abs(cost.amount - ((60 * 2 + 10 * 3 + 10 * 8) / 1_000_000 + 30 * 0.000006 + 10 * 0.00002)) < 1e-12);
  assert.equal(resolveUsageTotals(usage).totalTokens, 120);
});

test("uses provider amounts and enforces USD budgets with complete accounting", () => {
  const usage = { totalTokens: 5, reportedCost: { amount: 0.03, currency: "USD", source: "provider receipt" } };
  assert.equal(priceUsage(usage, pricing).kind, "provider");
  assert.equal(priceUsage(usage, pricing).amount, 0.03);
  const meter = new RunBudgetMeter(resolveRunBudget({ pricing, maxCostUsd: 1 }));
  meter.recordUsage(usage);
  assert.equal(meter.snapshot().costUsd, 0.03);
  assert.equal(meter.snapshot().costComplete, true);
  assert.equal(meter.snapshot().costKind, "provider");
  assert.throws(() => meter.recordUsage({ ...usage, reportedCost: { ...usage.reportedCost, currency: "EUR" } }), { code: "RUN_BUDGET_USAGE_UNAVAILABLE" });
  assert.throws(() => resolveRunBudget({ pricing: { ...pricing, currency: "EUR" }, maxCostUsd: 1 }), /USD/);
  const partial = new RunBudgetMeter(resolveRunBudget({ pricing, maxCostUsd: 1 }));
  assert.throws(() => partial.recordUsage({ inputTokens: 10, outputTokens: 2, completeness: { status: "partial", reason: "retry-usage-missing" } }), { code: "RUN_BUDGET_USAGE_UNAVAILABLE" });
  assert.equal(partial.snapshot().costComplete, false);
});

test("supports a shared custom pricing interface and immutable schedule snapshots", () => {
  const schedule = { ...pricing, items: { search: { unit: "requests", perUnit: 0.01 } } };
  const resolved = resolvePriceSchedule(schedule);
  schedule.items.search.perUnit = 10;
  assert.equal(resolved.items.search.perUnit, 0.01);
  const usagePricer = (usage, rates) => ({ amount: usage.totalTokens * rates.inputPerMillion / 1_000_000, currency: rates.currency, kind: "estimated", complete: true, missingReasons: [], pricingVersion: rates.version });
  const meter = new RunBudgetMeter(resolveRunBudget({ pricing, usagePricer, maxCostUsd: 1 }));
  meter.recordUsage({ totalTokens: 100 });
  assert.deepEqual(meter.snapshot().latestCost, priceUsage({ totalTokens: 100 }, pricing, usagePricer));
  assert.throws(() => priceUsage({ totalTokens: 1 }, pricing, () => ({ currency: "USD", kind: "estimated", complete: true, missingReasons: [] })), /requires an amount/);
  assert.throws(() => resolveRunBudget({ pricing }, { pricing: { ...pricing, version: "changed" } }), /cannot override/);
  assert.doesNotThrow(() => resolveRunBudget({ pricing }, { pricing: Object.fromEntries(Object.entries(pricing).reverse()) }));
});

test("aggregates usage without discarding details or provider amounts", () => {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 2, reasoningTokens: 3,
    tokenRelations: { cachedRead: "input", reasoning: "output" }, reportedCost: { amount: 0.1, currency: "USD", source: "receipt" } };
  const total = aggregateUsage(usage, usage);
  assert.equal(total.cachedReadTokens, 4);
  assert.equal(total.reasoningTokens, 6);
  assert.equal(total.totalTokens, 30);
  assert.equal(total.reportedCost.amount, 0.2);
  assert.equal(aggregateUsage(total, undefined).completeness.status, "partial");
  assert.equal(aggregateUsage(usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 }).reportedCost, undefined);
});

test("a pricing exception retains known tokens and marks the cost incomplete", () => {
  let fail = false;
  const usagePricer = usage => {
    if (fail) throw new Error("Host pricing failed");
    return { amount: usage.totalTokens / 100, currency: "USD", kind: "estimated", complete: true, missingReasons: [] };
  };
  const meter = new RunBudgetMeter(resolveRunBudget({ usagePricer, maxCostUsd: 1 }));
  meter.recordUsage({ totalTokens: 5 });
  fail = true;
  assert.throws(() => meter.recordUsage({ totalTokens: 5 }), /Host pricing failed/);
  assert.equal(meter.snapshot().totalTokens, 10);
  assert.equal(meter.snapshot().costUsd, 0.05);
  assert.equal(meter.snapshot().usageComplete, true);
  assert.equal(meter.snapshot().costComplete, false);
  assert.equal(meter.snapshot().latestCost, undefined);
});
