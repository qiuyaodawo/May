import assert from "node:assert/strict";
import test from "node:test";
import { AgentApplication } from "../../dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";
import { loadMayConfig } from "../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../providers/dist/index.js";

test("a standalone application continues context with a real provider and retains one user input", { timeout: 60_000 }, async t => {
  const config = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
  const app = await AgentApplication.open({ model, store: new InMemorySessionStore(), permissionPolicy: () => "deny" });
  const events = [];
  const relay = (async () => { for await (const event of app.events) events.push(event); })();
  t.after(() => app.close());
  await (await app.submit({ input: "Reply with exactly CONTINUE_READY." })).result;
  const continued = await (await app.continue({ runBudget: { maxModelCalls: 1 } })).result;
  assert.equal(continued.modelCalls, 1);
  const history = await app.history();
  assert.equal(history.filter(event => event.type === "input.submitted").length, 1);
  assert.equal(history.filter(event => event.type === "run.started" && event.continuation).length, 1);
  assert.equal(history.some(event => event.type === "state.updated" && event.key === "may.goal"), false);
  await app.close(); await relay;
  assert.equal(events.filter(event => event.type === "run.event" && event.event.type === "run.completed").length, 2);
});
