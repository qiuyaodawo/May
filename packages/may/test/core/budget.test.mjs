import assert from "node:assert/strict";
import test from "node:test";
import { May, InMemoryContext, RunBudgetMeter, parallelToolScheduler } from "@sortedyuan/may/core";

const assistant = (toolCalls = []) => ({ role: "assistant", content: [], toolCalls });
const tool = {
  name: "work",
  description: "work",
  inputSchema: {},
  async execute() {
    return "done";
  },
};
const calls = [
  { id: "a", name: "work", input: {} },
  { id: "b", name: "work", input: {} },
];
const collect = async (events) => {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
};

test("reserves an entire parallel tool batch before any side effect", async () => {
  let executed = 0;
  const context = new InMemoryContext();
  const may = new May({
    context,
    tools: [
      {
        ...tool,
        async execute() {
          executed++;
        },
      },
    ],
    toolScheduler: parallelToolScheduler,
    runBudget: { maxToolCalls: 1 },
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistant(calls) };
      },
    },
  });
  const run = may.run({ input: "go" });
  const events = collect(run.events);
  await assert.rejects(run.result, { code: "RUN_BUDGET_EXCEEDED" });
  assert.equal(executed, 0);
  assert.equal((await context.snapshot()).messages.filter((m) => m.role === "tool").length, 2);
  assert.equal((await events).filter((e) => e.type === "run.budget.exceeded").length, 1);
});

test("accumulates token usage across responses and exposes the exceeded dimension", async () => {
  let requests = 0;
  const may = new May({
    context: new InMemoryContext(),
    tools: [tool],
    runBudget: { maxTotalTokens: 10 },
    model: {
      async *stream() {
        requests++;
        yield {
          type: "response.completed",
          message: assistant(requests === 1 ? [calls[0]] : []),
          usage: { inputTokens: 4, outputTokens: 2 },
        };
      },
    },
  });
  await assert.rejects(
    may.run({ input: "go" }).result,
    (error) => error.dimension === "totalTokens" && error.consumed === 12,
  );
  assert.equal(requests, 2);
});

test("missing required usage fails closed and closes proposed tool calls", async () => {
  let executed = 0;
  const may = new May({
    context: new InMemoryContext(),
    tools: [
      {
        ...tool,
        async execute() {
          executed++;
        },
      },
    ],
    runBudget: { maxTotalTokens: 10 },
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistant(calls) };
      },
    },
  });
  await assert.rejects(may.run({ input: "go" }).result, { code: "RUN_BUDGET_USAGE_UNAVAILABLE" });
  assert.equal(executed, 0);
});

test("time budget aborts an in-flight model and emits failure rather than user cancellation", async () => {
  const may = new May({
    context: new InMemoryContext(),
    runBudget: { maxDurationMs: 20 },
    model: {
      async *stream(_request, { signal }) {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    },
  });
  const run = may.run({ input: "go" });
  const events = collect(run.events);
  await assert.rejects(run.result, (e) => e.dimension === "durationMs");
  assert.deepEqual(
    (await events).filter((e) => ["run.failed", "run.cancelled"].includes(e.type)).map((e) => e.type),
    ["run.failed"],
  );
});

test("model limits apply before the next request and continuations receive fresh budgets", async () => {
  let requests = 0;
  const may = new May({
    context: new InMemoryContext(),
    tools: [tool],
    runBudget: { maxModelCalls: 1 },
    model: {
      async *stream() {
        requests++;
        yield {
          type: "response.completed",
          message: assistant(requests === 1 ? [calls[0]] : []),
          usage: { totalTokens: 1 },
        };
      },
    },
  });
  await assert.rejects(may.run({ input: "go" }).result, (e) => e.dimension === "modelCalls");
  const result = await may.continue().result;
  assert.equal(result.budget.modelCalls, 1);
  assert.equal(result.budget.totalTokens, 1);
});

test("cost caps use explicit prices and return observed spend", async () => {
  const may = new May({
    context: new InMemoryContext(),
    runBudget: { maxCostUsd: 0.01, tokenPrices: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistant(), usage: { inputTokens: 10000, outputTokens: 1 } };
      },
    },
  });
  await assert.rejects(may.run({ input: "go" }).result, (e) => e.dimension === "costUsd" && e.consumed > 0.02);
});

test("deadline closes interrupted tool calls before continuation", async () => {
  const context = new InMemoryContext();
  const may = new May({
    context,
    runBudget: { maxDurationMs: 30 },
    tools: [
      {
        ...tool,
        async execute(_input, { signal }) {
          await new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      },
    ],
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistant(calls) };
      },
    },
  });
  const run = may.run({ input: "go" });
  const events = collect(run.events);
  await assert.rejects(run.result, { code: "RUN_BUDGET_EXCEEDED" });
  assert.equal((await context.snapshot()).messages.filter((m) => m.role === "tool").length, 2);
  assert.equal((await events).filter((e) => e.type === "tool.failed").length, 2);
});

test("duration budget uses a monotonic clock immune to forward and backward Date.now jumps within the same run", async () => {
  const originalDateNow = Date.now;
  let offsetMs = 0;
  Date.now = () => originalDateNow() + offsetMs;
  try {
    // Directly exercise a single RunBudgetMeter across both +10m and -10m wall-clock jumps.
    const meter = new RunBudgetMeter({ maxDurationMs: 5_000 });
    const s1 = meter.snapshot();
    offsetMs = 600_000;
    meter.checkTime();
    const s2 = meter.snapshot();
    offsetMs = -600_000;
    meter.checkTime();
    const s3 = meter.snapshot();
    assert.ok(s1.elapsedMs >= 0 && s1.elapsedMs <= s2.elapsedMs && s2.elapsedMs <= s3.elapsedMs);
    assert.ok(s3.elapsedMs < 5_000, `expected monotonic elapsedMs < 5000, got ${s3.elapsedMs}`);

    // Also exercise a single multi-step May run spanning both forward and backward Date.now jumps.
    offsetMs = 0;
    let step = 0;
    const may = new May({
      context: new InMemoryContext(),
      tools: [tool],
      runBudget: { maxDurationMs: 5_000 },
      model: {
        async *stream() {
          step += 1;
          offsetMs = step === 1 ? 600_000 : -600_000;
          yield {
            type: "response.completed",
            message: assistant(step === 1 ? [calls[0]] : []),
            usage: { totalTokens: 1 },
          };
        },
      },
    });
    const result = await may.run({ input: "go" }).result;
    assert.equal(step, 2);
    assert.ok(result.budget.elapsedMs >= 0 && result.budget.elapsedMs < 5_000);
  } finally {
    Date.now = originalDateNow;
  }
});
