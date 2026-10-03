import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, definePlugin, defineService } from "../../plugin/dist/index.js";
import { ContextWrappers, services } from "../../plugin-services/dist/index.js";
import { createCompositionPlugin } from "../dist/plugins.js";

test("application registries coexist with actual host registries using the same service id", async () => {
  const token = defineService({ id: services.contextWrappers.id, version: "1.0.0", scope: "host" });
  const wrappers = new ContextWrappers();
  const provider = definePlugin({ id: "scope.host-wrappers", version: "1.0.0", scope: "host", provides: [token],
    setup(context) { context.provide(token, wrappers); },
  });
  const host = await PluginHost.create({ plugins: [provider, createCompositionPlugin([provider]), definePlugin({
    id: "scope.application-consumer", version: "1.0.0", scope: "application", requires: [{ service: services.contextWrappers }], setup() {},
  })] });
  try {
    const application = await host.createScope("application", { id: "independent" });
    assert.equal(application.get(token), wrappers);
    assert.ok(application.get(services.contextWrappers) instanceof ContextWrappers);
    assert.notEqual(application.get(services.contextWrappers), wrappers);
  } finally { await host.close(); }
});

test("an application registry replaces only the default service in the same scope", async () => {
  const wrappers = new ContextWrappers();
  const provider = definePlugin({ id: "scope.application-wrappers", version: "1.0.0", provides: [services.contextWrappers],
    setup(context) { context.provide(services.contextWrappers, wrappers); },
  });
  const host = await PluginHost.create({ plugins: [provider, createCompositionPlugin([provider])] });
  try {
    const application = await host.createScope("application", { id: "replacement" });
    assert.equal(application.get(services.contextWrappers), wrappers);
  } finally { await host.close(); }
});
