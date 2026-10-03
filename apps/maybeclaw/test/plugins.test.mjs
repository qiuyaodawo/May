import assert from "node:assert/strict";
import test from "node:test";
import { parseMayConfig } from "@may/config";
import { loadPluginModules, PluginHost } from "@may/plugin";
import { gatewaySettings } from "../dist/gateway-settings.js";

function configuration(agents) {
  return parseMayConfig({ providers: {}, apps: { maybeclaw: { version: 2, agents } } }, import.meta.filename);
}

test("May Agent plugin selections preserve configuration and initialize real plugin state", async () => {
  const selection = {
    module: new URL("../../../packages/plugin/test/module-plugin.mjs", import.meta.url).href,
    config: { increment: 4 },
  };
  const config = configuration([{ id: "configured", adapter: "may", plugins: [selection] }]);
  const settings = gatewaySettings(config);
  assert.deepEqual(settings.agents[0].plugins, [selection]);
  const plugins = await loadPluginModules(settings.agents[0].plugins, config.path);
  const host = await PluginHost.create({ plugins });
  try {
    const application = await host.createScope("application", { id: "configured" });
    assert.equal(application.snapshotState()["module-state"].value.opened, 4);
  } finally {
    await host.close();
  }
});

test("Agent configuration validates plugin fields before loading modules", () => {
  assert.throws(() => gatewaySettings(configuration([{ id: "invalid", adapter: "may", plugins: [{}] }])), /module/);
  assert.throws(() => gatewaySettings(configuration([{ id: "invalid", adapter: "may", plugins: [{ module: "unused", enabled: "false" }] }])), /boolean/);
  assert.throws(() => gatewaySettings(configuration([{ id: "invalid", adapter: "module", module: "unused", plugins: [] }])), /plugins/);
});
