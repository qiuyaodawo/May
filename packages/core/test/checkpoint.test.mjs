import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContext, May, parallelToolScheduler } from "../dist/index.js";

test("yield closes the complete tool step and awaits its own checkpoint before releasing the Run", async () => {
  for (const fail of [false, true]) {
    const context = new InMemoryContext(); let calls = 0, persisted = 0;
    const may = new May({ context, tools: [{ name: "work", description: "work", inputSchema: {}, async execute() { return "done"; } }],
      model: { async *stream() { calls++; yield { type: "response.completed", message: { role: "assistant", content: [], toolCalls: [{ id: "work", name: "work", input: {} }] } }; } },
    });
    const run = may.run({ input: "go", shouldYield: () => true, checkpoint: async (event) => {
      if (event.type !== "run.yielded") return;
      persisted++;
      assert.equal((await context.snapshot()).messages.at(-1).role, "tool");
      if (fail) throw new Error("yield persistence failed");
    } });
    const events = []; const observer = (async () => { for await (const event of run.events) events.push(event); })();
    if (fail) await assert.rejects(run.result, { code: "RUN_CHECKPOINT_FAILED" });
    else assert.equal((await run.result).finishReason, "yielded");
    await observer;
    assert.equal(events.at(-1).type, fail ? "run.failed" : "run.yielded");
    assert.equal(events.some((event) => event.type === "run.completed" || event.type === "run.cancelled"), false);
    assert.equal(calls, 1); assert.equal(persisted, 1);
  }
});

test("a failed parallel checkpoint aborts and settles peers without claiming cancellation or replaying persistence", async () => {
  let peerStarted; const started = new Promise((resolve) => { peerStarted = resolve; });
  let peerSettled = false; let checkpointAttempts = 0;
  const tools = [
    { name: "first", description: "first", inputSchema: {}, async execute() { await started; return "side effect completed"; } },
    { name: "peer", description: "peer", inputSchema: {}, async execute(_input, { signal }) {
      peerStarted();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { peerSettled = true; reject(signal.reason); });
      }, { once: true }));
    } },
  ];
  const may = new May({ context: new InMemoryContext(), toolScheduler: parallelToolScheduler, tools,
    model: { async *stream() { yield { type: "response.completed", message: { role: "assistant", content: [], toolCalls: tools.map((tool) => ({ name: tool.name, id: tool.name, input: {} })) } }; } },
  });
  const run = may.run({ input: "go", checkpoint: async (event) => {
    if (event.type === "tool.completed") { checkpointAttempts++; throw new Error("disk failed"); }
  } });
  const events = []; const observation = (async () => { for await (const event of run.events) events.push(event); })();
  await assert.rejects(run.result, { code: "RUN_CHECKPOINT_FAILED" });
  await observation;
  assert.equal(peerSettled, true);
  assert.equal(checkpointAttempts, 1);
  assert.equal(events.some((event) => event.type === "run.cancelled" || event.type === "tool.completed"), false);
  assert.equal(events.at(-1).type, "run.failed");
});
