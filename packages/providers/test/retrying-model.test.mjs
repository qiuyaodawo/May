import assert from "node:assert/strict";
import test from "node:test";
import { RetryingModel } from "../dist/index.js";
import { MAX_TIMER_MS, nextSleepChunkMs, sleepChunkSchedule } from "../dist/sleep-chunks.js";

const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

async function collect(iterable) {
  const out = [];
  for await (const event of iterable) out.push(event);
  return out;
}

test("sleep chunk arithmetic caps each slice at 2^31-1 ms and preserves exact total duration", () => {
  assert.equal(MAX_TIMER_MS, 2_147_483_647);
  assert.equal(nextSleepChunkMs(0), 0);
  assert.equal(nextSleepChunkMs(-5), 0);
  assert.equal(nextSleepChunkMs(100), 100);
  assert.equal(nextSleepChunkMs(2_147_483_650), 2_147_483_647);
  assert.deepEqual(sleepChunkSchedule(0), []);
  assert.deepEqual(sleepChunkSchedule(2_147_483_650), [2_147_483_647, 3]);
  assert.deepEqual(sleepChunkSchedule(5_000_000_000), [2_147_483_647, 2_147_483_647, 705_032_706]);
});

test("RetryingModel allows maxDelayMs above 32-bit timer limit and passes exact delay to custom sleep", async () => {
  const observedDelays = [];
  let attempts = 0;
  const model = new RetryingModel(
    {
      async *stream() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transient"), { status: 429 });
        }
        yield {
          type: "response.completed",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        };
      },
    },
    {
      maxAttempts: 2,
      baseDelayMs: 2_147_483_648,
      maxDelayMs: 2_147_483_648,
      jitterRatio: 0,
      sleep: async (ms) => {
        observedDelays.push(ms);
      },
    },
  );

  const events = await collect(model.stream(request, { signal: new AbortController().signal }));
  assert.equal(attempts, 2);
  assert.deepEqual(observedDelays, [2_147_483_648]);
  assert.equal(events.at(-1).type, "response.completed");
});

test(
  "RetryingModel built-in abortableSleep handles delays > 2^31-1 ms without TimeoutOverflowWarning or premature retry",
  { timeout: 5_000 },
  async () => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on("warning", onWarning);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error("user cancelled")), 120);
    let attempts = 0;

    try {
      const model = new RetryingModel(
        {
          async *stream() {
            attempts += 1;
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        },
        {
          maxAttempts: 2,
          baseDelayMs: 5_000_000_000,
          maxDelayMs: 5_000_000_000,
          jitterRatio: 0,
        },
      );

      const started = performance.now();
      await assert.rejects(collect(model.stream(request, { signal: controller.signal })), /user cancelled/);
      const elapsed = performance.now() - started;

      assert.equal(attempts, 1, "must not overflow setTimeout to 1ms and prematurely run attempt 2");
      assert.ok(elapsed >= 80, `expected sleep to wait until abort (~120ms), finished in ${elapsed}ms`);
      assert.deepEqual(
        warnings.filter((w) => w.name === "TimeoutOverflowWarning"),
        [],
        "chunked timer must not emit Node TimeoutOverflowWarning",
      );
    } finally {
      clearTimeout(abortTimer);
      process.removeListener("warning", onWarning);
    }
  },
);
