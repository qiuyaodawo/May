import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost } from "@may/plugin";
import { APPLICATION_HOOKS } from "@may/application";
import { createGoalsPlugin, goalsService } from "../dist/index.js";

test("goal lifecycle requires application access and declared composition services before setup", async () => {
  const plugin = createGoalsPlugin();
  assert.equal(plugin.provides[0], goalsService);
  await assert.rejects(PluginHost.create({ plugins: [plugin], hooks: APPLICATION_HOOKS }), /requires missing service/u);
});
