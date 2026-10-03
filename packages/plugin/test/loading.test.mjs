import assert from "node:assert/strict";
import test from "node:test";
import { loadPluginModules, parsePluginSelections, PluginHost } from "../dist/index.js";

test("local module selections configure real scoped plugin state", async () => {
  const plugins = await loadPluginModules([
    { module: "./module-plugin.mjs", config: { increment: 3 } },
    { module: "./does-not-exist.mjs", enabled: false },
  ], import.meta.url);
  const host = await PluginHost.create({ plugins });
  const scope = await host.createScope("application", { id: "loaded" });
  assert.equal(scope.snapshotState()["module-state"].value.opened, 3);
  await host.close();
});

test("module selection rejects malformed metadata and non-file modules", async () => {
  assert.throws(() => parsePluginSelections([{ module: "x", enabled: "yes" }]));
  assert.throws(() => parsePluginSelections([{ module: "x", extra: true }]));
  await assert.rejects(loadPluginModules([{ module: "node:fs" }], import.meta.url), /local files/);
  await assert.rejects(loadPluginModules([{ module: "./module-plugin.mjs", export: "missing" }], import.meta.url), /PluginDefinition/);
});
