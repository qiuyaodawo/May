import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { priceUsage, resolveRunBudget, RunBudgetMeter } from "@may/core";
import { FileSharedBudget } from "../dist/index.js";

const pricing = { id: "host", version: "2026-10-05", currency: "USD", source: "configuration", effectiveAt: "2026-10-05T00:00:00Z",
  inputPerMillion: 2, outputPerMillion: 8, cachedReadPerMillion: 0.2 };
const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 80, tokenRelations: { cachedRead: "input" } };

async function directory(t) {
  const root = fileURLToPath(new URL("../../../review/metering-tests/", import.meta.url));
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "budget-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("shared and Run budgets use identical versioned pricing and durable cost receipts", async t => {
  const root = await directory(t);
  const limits = { maxModelCalls: 4, maxCostUsd: 1, pricing };
  let shared = await FileSharedBudget.open(root, "prices", limits);
  await shared.reserveCall("call", { totalTokens: 200, costUsd: 0.1 });
  await shared.settleCall("call", usage);
  const meter = new RunBudgetMeter(resolveRunBudget({ pricing, maxCostUsd: 1 }));
  meter.recordUsage(usage);
  const snapshot = await shared.snapshot();
  assert.deepEqual(snapshot.calls[0].cost, meter.snapshot().latestCost);
  assert.equal((await shared.totals()).costUsd, meter.snapshot().costUsd);
  assert.equal((await shared.totals()).costComplete, true);
  await shared.close();
  shared = await FileSharedBudget.open(root, "prices", limits);
  assert.deepEqual((await shared.snapshot()).calls[0].cost, priceUsage(usage, pricing));
  await shared.close();
  await assert.rejects(FileSharedBudget.open(root, "prices", { ...limits, pricing: { ...pricing, version: "changed" } }), /changed limits/);
});

test("shared budgets reject incomplete required prices and preserve estimated reservations", async t => {
  const root = await directory(t);
  const shared = await FileSharedBudget.open(root, "missing", { maxModelCalls: 4, maxCostUsd: 1, pricing });
  await shared.reserveCall("partial", { totalTokens: 200, costUsd: 0.1 });
  await assert.rejects(shared.settleCall("partial", { ...usage, tokenRelations: undefined }), /unavailable/);
  await shared.markCallUnknown("partial");
  assert.equal((await shared.totals()).usageComplete, false);
  await shared.reconcile("partial", usage, "host receipt");
  await shared.runExternal("external", { totalTokens: 200, costUsd: 0.1 }, async () => ({ messages: [] }));
  const snapshot = await shared.snapshot();
  assert.equal(snapshot.calls[1].cost.kind, "estimated");
  assert.equal(snapshot.calls[1].cost.source, "reservation");
  assert.equal((await shared.totals()).costComplete, false);
  await shared.close();
});

test("shared budgets preserve custom pricing receipts without calling the pricer during journal validation", async t => {
  const root = await directory(t);
  const limits = { maxModelCalls: 4, maxCostUsd: 1, pricing };
  let calls = 0;
  const usagePricer = (_usage, rates) => {
    calls += 1;
    return { amount: calls / 100, currency: "USD", kind: "estimated", complete: true, missingReasons: [], pricingVersion: rates.version };
  };
  let shared = await FileSharedBudget.open(root, "custom", limits, { usagePricer });
  await shared.reserveCall("one", { totalTokens: 200, costUsd: 0.1 });
  await shared.settleCall("one", usage);
  await shared.reserveCall("two", { totalTokens: 200, costUsd: 0.1 });
  await shared.settleCall("two", usage);
  assert.equal(calls, 2);
  assert.equal((await shared.totals()).costUsd, 0.03);
  await shared.close();
  shared = await FileSharedBudget.open(root, "custom", limits, { usagePricer });
  assert.equal(calls, 2);
  assert.equal((await shared.snapshot()).calls[0].cost.amount, 0.01);
  await shared.close();
});

test("shared and Run budgets preserve provider receipts and reject non-USD settlement", async t => {
  const root = await directory(t);
  const shared = await FileSharedBudget.open(root, "provider-receipt", { maxModelCalls: 4, maxCostUsd: 1, pricing });
  const receipt = { totalTokens: 5, reportedCost: { amount: 0.03, currency: "USD", source: "provider receipt" } };
  const meter = new RunBudgetMeter(resolveRunBudget({ maxCostUsd: 1, pricing }));
  meter.recordUsage(receipt);
  await shared.reserveCall("usd", { totalTokens: 10, costUsd: 0.1 });
  await shared.settleCall("usd", receipt);
  assert.deepEqual((await shared.snapshot()).calls[0].cost, meter.snapshot().latestCost);
  assert.equal((await shared.totals()).costUsd, meter.snapshot().costUsd);
  assert.equal((await shared.totals()).costComplete, true);
  await shared.reserveCall("eur", { totalTokens: 10, costUsd: 0.1 });
  const foreign = { ...receipt, reportedCost: { ...receipt.reportedCost, currency: "EUR" } };
  await assert.rejects(shared.settleCall("eur", foreign), /unavailable/);
  assert.throws(() => meter.recordUsage(foreign), { code: "RUN_BUDGET_USAGE_UNAVAILABLE" });
  await shared.markCallUnknown("eur");
  const snapshot = await shared.snapshot(), totals = await shared.totals();
  assert.equal(snapshot.calls[1].status, "unknown");
  assert.equal(snapshot.calls[1].cost, undefined);
  assert.equal(totals.costUsd, 0.13);
  assert.equal(totals.costComplete, false);
  assert.equal(totals.blocked, true);
  await shared.close();
});
