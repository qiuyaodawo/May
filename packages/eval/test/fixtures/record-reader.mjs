import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { FileEvalStore } from "../../dist/file-store.js";

const store = new FileEvalStore({ directory: process.argv[2] });
let stopped = false;
process.on("message", message => { if (message === "stop") stopped = true; });
process.send("ready");
let reads = 0;
while (!stopped) {
  const plan = await store.readPlan("concurrent");
  assert.ok(plan.trials.length >= 1);
  reads++;
  await setImmediate();
}
process.send({ reads, trials: (await store.readPlan("concurrent")).trials.length });
process.disconnect();
