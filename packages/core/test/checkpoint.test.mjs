import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContext, May, parallelToolScheduler } from "../dist/index.js";

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
