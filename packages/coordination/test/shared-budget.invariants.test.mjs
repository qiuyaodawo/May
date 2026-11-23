import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestDirectory, fc, pbtRuns } from "@sortedyuan/test-support";
import { FileSharedBudget } from "../dist/index.js";

function oracleTotals(oracleCalls, limits) {
  const calls = [...oracleCalls.values()];
  const modelCalls = calls.length;
  const totalTokens = calls.reduce(
    (sum, call) => sum + (call.status === "settled" ? call.totalTokens : call.reservation),
    0,
  );
  const blocked =
    calls.some((call) => call.status === "unknown" || call.exceededReservation) ||
    modelCalls > limits.maxModelCalls ||
    totalTokens > limits.maxTotalTokens;
  const usageComplete = calls.every((call) => call.status === "settled");
  return { modelCalls, totalTokens, blocked, usageComplete };
}

test("regression: marking a reconciled call unknown clears stale estimated/settled fields cleanly", async (t) => {
  const dir = await createTestDirectory(t, "coordination/budget-reconcile-unknown");
  let budget = await FileSharedBudget.open(dir, "budget-reg", { maxModelCalls: 2, maxTotalTokens: 30 });
  try {
    await budget.reserveCall("call-1", { totalTokens: 5 });
    await budget.close();
    budget = await FileSharedBudget.open(dir, "budget-reg", { maxModelCalls: 2, maxTotalTokens: 30 });
    await budget.reconcile("call-1", { totalTokens: 5 }, "host-receipt");
    await budget.markCallUnknown("call-1");
    const snap = await budget.snapshot();
    assert.deepEqual(snap.calls, [{ id: "call-1", status: "unknown", reservation: { totalTokens: 5 } }]);
    await assert.rejects(budget.reserveCall("call-2", { totalTokens: 5 }), /unknown model usage/);
  } finally {
    await budget.close();
  }
});

test("invariant: FileSharedBudget matches exact state-machine oracle across reserve, settle, unknown, reconcile, and crash reopen", async (t) => {
  const parentDir = await createTestDirectory(t, "coordination/budget-pbt");
  const opArb = fc.oneof(
    fc.record({
      kind: fc.constant("reserve"),
      callId: fc.constantFrom("call-1", "call-2", "call-3", "call-4", "call-5"),
      tokens: fc.integer({ min: 1, max: 30 }),
    }),
    fc.record({
      kind: fc.constant("settle"),
      callId: fc.constantFrom("call-1", "call-2", "call-3", "call-4", "call-5"),
      actual: fc.option(fc.integer({ min: 1, max: 35 }), { nil: undefined }),
    }),
    fc.record({
      kind: fc.constant("unknown"),
      callId: fc.constantFrom("call-1", "call-2", "call-3", "call-4", "call-5"),
    }),
    fc.record({
      kind: fc.constant("reconcile"),
      callId: fc.constantFrom("call-1", "call-2", "call-3", "call-4", "call-5"),
      actual: fc.integer({ min: 1, max: 25 }),
    }),
    fc.record({ kind: fc.constant("reopen") }),
  );

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 5 }),
      fc.integer({ min: 30, max: 120 }),
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      async (maxModelCalls, maxTotalTokens, ops) => {
        const dir = await mkdtemp(join(parentDir, "iter-"));
        const limits = { maxModelCalls, maxTotalTokens };
        let budget = await FileSharedBudget.open(dir, "budget-pbt", limits);
        const oracle = new Map();

        const assertMatchesOracle = async () => {
          const snap = await budget.snapshot();
          const totals = await budget.totals();
          const expected = oracleTotals(oracle, limits);

          assert.equal(totals.modelCalls, expected.modelCalls);
          assert.ok(totals.modelCalls <= maxModelCalls);
          assert.equal(totals.totalTokens, expected.totalTokens);
          assert.equal(totals.blocked, expected.blocked);
          assert.equal(totals.usageComplete, expected.usageComplete);

          const actualSummary = snap.calls.map((c) => ({
            id: c.id,
            status: c.status,
            reservation: c.reservation.totalTokens,
            totalTokens: c.status === "settled" ? c.totalTokens : undefined,
            exceededReservation: c.exceededReservation ?? false,
          }));
          const expectedSummary = [...oracle.values()].map((c) => ({
            id: c.id,
            status: c.status,
            reservation: c.reservation,
            totalTokens: c.status === "settled" ? c.totalTokens : undefined,
            exceededReservation: c.exceededReservation,
          }));
          assert.deepEqual(actualSummary, expectedSummary);
        };

        try {
          for (const op of ops) {
            if (op.kind === "reopen") {
              await budget.close();
              budget = await FileSharedBudget.open(dir, "budget-pbt", limits);
              for (const entry of oracle.values()) {
                if (entry.status === "pending") entry.status = "unknown";
              }
              const after = await budget.snapshot();
              assert.equal(
                after.calls.some((call) => call.status === "pending"),
                false,
                "reopening a budget must turn surviving pending calls into unknown",
              );
            } else if (op.kind === "reserve") {
              const currentTotals = oracleTotals(oracle, limits);
              if (oracle.has(op.callId)) {
                await assert.rejects(budget.reserveCall(op.callId, { totalTokens: op.tokens }), /already reserved/);
              } else if (currentTotals.blocked) {
                await assert.rejects(
                  budget.reserveCall(op.callId, { totalTokens: op.tokens }),
                  /unknown model usage|limit reached/,
                );
              } else if (
                currentTotals.modelCalls + 1 > maxModelCalls ||
                currentTotals.totalTokens + op.tokens > maxTotalTokens
              ) {
                await assert.rejects(
                  budget.reserveCall(op.callId, { totalTokens: op.tokens }),
                  /insufficient unreserved capacity/,
                );
              } else {
                await budget.reserveCall(op.callId, { totalTokens: op.tokens });
                oracle.set(op.callId, {
                  id: op.callId,
                  status: "pending",
                  reservation: op.tokens,
                  totalTokens: undefined,
                  exceededReservation: false,
                });
              }
            } else if (op.kind === "settle") {
              await budget.settleCall(op.callId, op.actual === undefined ? undefined : { totalTokens: op.actual });
              const entry = oracle.get(op.callId);
              if (entry) {
                if (op.actual === undefined) {
                  entry.status = "unknown";
                  entry.totalTokens = undefined;
                  entry.exceededReservation = false;
                } else {
                  entry.status = "settled";
                  entry.totalTokens = op.actual;
                  entry.exceededReservation = op.actual > entry.reservation;
                }
              }
            } else if (op.kind === "unknown") {
              await budget.markCallUnknown(op.callId);
              const entry = oracle.get(op.callId);
              if (entry) {
                entry.status = "unknown";
                entry.totalTokens = undefined;
                entry.exceededReservation = false;
              }
            } else if (op.kind === "reconcile") {
              const entry = oracle.get(op.callId);
              if (!entry || (entry.status !== "unknown" && !entry.exceededReservation)) {
                await assert.rejects(
                  budget.reconcile(op.callId, { totalTokens: op.actual }, "pbt-evidence"),
                  /Only unknown usage or an exceeded reservation can be reconciled/,
                );
              } else {
                await budget.reconcile(op.callId, { totalTokens: op.actual }, "pbt-evidence");
                entry.status = "settled";
                entry.totalTokens = op.actual;
                entry.exceededReservation = false;
              }
            }
            await assertMatchesOracle();
          }
        } finally {
          await budget.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: pbtRuns(25) },
  );
});
