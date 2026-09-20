import assert from "node:assert/strict";
import test from "node:test";
import { goalBudget, goalText, restoreGoal } from "../dist/index.js";

test("goal budgets apply only explicitly supplied limits", () => {
  assert.deepEqual(goalBudget(), {});
  for (const budget of [{ maxRuns: 3 }, { maxDurationMs: 1000 }, { maxTotalTokens: 1000 }, { maxRuns: 4, maxDurationMs: 2000, maxTotalTokens: 5000 }]) {
    assert.deepEqual(goalBudget(budget), budget);
  }
  for (const field of ["maxRuns", "maxDurationMs", "maxTotalTokens"]) {
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => goalBudget({ [field]: value }));
  }
  assert.throws(() => goalBudget({ maxRuns: 10001 }));
  assert.throws(() => goalBudget({ maxDurationMs: 2_147_483_648 }));
  assert.throws(() => goalBudget({ unknown: 1 }));
  assert.equal(goalText("  goal  ", "objective"), "goal");
  assert.throws(() => goalText(" ", "objective"));
});

test("persisted state validation rejects mismatched accounting and session identity", () => {
  const state = { version: 1, id: "goal", sessionId: "session", objective: "Check a result", status: "paused",
    budget: goalBudget(), usage: { runs: 1, totalTokens: 12, elapsedMs: 30, usageComplete: true },
    calls: [{ id: "request", runId: "run", status: "settled", tokens: 12 }], runIds: ["run"],
    progress: "", createdAt: 1, updatedAt: 2 };
  const restored = restoreGoal(state, "session");
  assert.deepEqual(restored, state);
  assert.notEqual(restored, state);
  for (const budget of [{}, { maxRuns: 32, maxDurationMs: 1_800_000 }, { maxTotalTokens: 1000 }]) {
    const saved = JSON.parse(JSON.stringify({ ...state, budget }));
    assert.deepEqual(restoreGoal(saved, "session").budget, budget);
  }
  assert.throws(() => restoreGoal(state, "other"));
  assert.throws(() => restoreGoal({ ...state, version: 2 }, "session"));
  assert.throws(() => restoreGoal({ ...state, calls: [] }, "session"));
  assert.throws(() => restoreGoal({ ...state, calls: [state.calls[0], state.calls[0]] }, "session"));
  assert.throws(() => restoreGoal({ ...state, usage: { ...state.usage, runs: -1 } }, "session"));
});
