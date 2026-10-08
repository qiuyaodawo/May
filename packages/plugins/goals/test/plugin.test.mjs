import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, definePlugin } from "@may/plugin";
import { APPLICATION_HOOKS, AgentApplication, applicationServices } from "@may/application";
import { createGoalsPlugin, goalsService } from "../dist/index.js";
import { runtimeHooks } from "../../../core/dist/index.js";
import { DeepSeekModel } from "../../../providers/deepseek/dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";
import { createHistoryMemoryPlugin } from "../../history-memory/dist/index.js";

test("goal lifecycle requires application access and declared composition services before setup", async () => {
  const plugin = createGoalsPlugin();
  assert.equal(plugin.provides[0], goalsService);
  await assert.rejects(PluginHost.create({ plugins: [plugin], hooks: APPLICATION_HOOKS }), /requires missing service/u);
});

test("Goal and history plugins compose ordered guidance once in a real application Context", async t => {
  let application;
  let captured;
  let sources;
  application = await AgentApplication.open({
    model: new DeepSeekModel({ apiKey: "unused-before-provider-dispatch", model: "deepseek-chat" }),
    store: new InMemorySessionStore(),
    instructions: "Complete the assigned work.",
    plugins: [
      createHistoryMemoryPlugin({ mode: "history-reference" }), createGoalsPlugin(),
      definePlugin({
        id: "verification.goal-instructions", version: "1.0.0",
        requires: [{ service: applicationServices.instructionSources }],
        requiresHooks: [runtimeHooks.contextAfter],
        setup(context) {
          context.defer(context.get(applicationServices.instructionSources).add(
            () => "Between Goal and history guidance.", { id: context.pluginId, order: 50 },
          ));
          context.on(runtimeHooks.contextAfter, snapshot => {
            captured = snapshot;
            sources = application.getService(applicationServices.instructionSources).snapshot();
            application.getService(goalsService).interrupt("Context verification completed before provider dispatch");
            return snapshot;
          });
        },
      }),
    ],
  });
  t.after(() => application.close());
  const goal = application.getService(goalsService);
  assert.doesNotMatch(application.getService(applicationServices.instructionSources).snapshot(), /# Active goal/u);
  await goal.start("Inspect the current source", { maxRuns: 2 });
  await goal.wait();
  assert.equal(goal.getGoal().status, "paused");
  assert.equal(goal.getGoal().calls.length, 0);
  assert.equal(captured.instructions.match(/# Active goal/gu).length, 1);
  assert.equal(captured.instructions.match(/# Context continuity/gu).length, 1);
  assert.ok(sources.indexOf("# Active goal") < sources.indexOf("Between Goal"));
  assert.ok(sources.indexOf("Between Goal") < sources.indexOf("# Context continuity"));
  assert.ok(captured.instructions.endsWith("Continue the active goal from its current state."));
  assert.doesNotMatch(sources, /Continue the active goal/u);
  assert.doesNotMatch(application.getService(applicationServices.instructionSources).snapshot(), /# Active goal/u);
});
