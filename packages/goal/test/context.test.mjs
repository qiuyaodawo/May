import assert from "node:assert/strict";
import test from "node:test";
import { GoalController } from "../dist/index.js";
import { AgentApplication } from "../../application/dist/index.js";
import { runtimeHooks } from "../../core/dist/index.js";
import { InMemoryContextFactory } from "../../context/dist/index.js";
import { definePlugin } from "../../plugin/dist/index.js";
import { DeepSeekModel } from "../../providers/deepseek/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";

test("independent Goal composition refreshes active instructions in a real Context before provider dispatch", async t => {
  const goal = new GoalController();
  let captured;
  const application = await AgentApplication.open({
    model: goal.wrapModel(new DeepSeekModel({ apiKey: "unused-before-provider-dispatch", model: "deepseek-chat" })),
    store: new InMemorySessionStore(),
    instructions: "Complete the assigned work.",
    contextFactory: goal.wrapContextFactory(new InMemoryContextFactory()),
    plugins: [definePlugin({
      id: "verification.goal-context", version: "1.0.0", requiresHooks: [runtimeHooks.contextAfter],
      setup(context) {
        context.on(runtimeHooks.contextAfter, snapshot => {
          captured = snapshot;
          goal.interrupt("Context verification completed before provider dispatch");
          return snapshot;
        });
      },
    })],
  });
  t.after(async () => { await goal.close(); await application.close(); });
  await goal.attach(application, {
    read: async () => {
      const event = [...await application.history()].reverse().find(item => item.type === "state.updated" && item.key === "verification.goal");
      return event?.value;
    },
    write: state => application.recordState("verification.goal", state),
  });
  await goal.start("Inspect the current source", { maxRuns: 2 });
  await goal.wait();
  assert.equal(goal.getGoal().status, "paused");
  assert.equal(goal.getGoal().calls.length, 0);
  assert.equal(captured.instructions.match(/# Active goal/gu).length, 1);
  assert.match(captured.instructions, /Objective: "Inspect the current source"/u);
  assert.match(captured.instructions, /Run: 1\/2/u);
  assert.ok(captured.instructions.endsWith("Continue the active goal from its current state."));
  assert.equal(goal.instructions(), "");
});
