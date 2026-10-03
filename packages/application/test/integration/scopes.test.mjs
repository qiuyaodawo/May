import assert from "node:assert/strict";
import test from "node:test";
import { loadMayConfig } from "../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../providers/dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";
import { InMemoryContextFactory } from "../../../context/dist/index.js";
import { defaultRuntimeFactory } from "../../../core/dist/index.js";
import { ContextWrappers, ModelWrappers, services } from "../../../plugin-services/dist/index.js";
import { definePlugin, defineService } from "../../../plugin/dist/index.js";
import { defineAgent } from "../../dist/index.js";

test("actual applications retain base defaults beside host services with matching ids", { timeout: 120000 }, async t => {
  const model = createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" }));
  const values = [
    [services.contextFactory, new InMemoryContextFactory()],
    [services.runtimeFactory, defaultRuntimeFactory],
    [services.permissionPolicy, () => "deny"],
    [services.modelWrappers, new ModelWrappers()],
    [services.contextWrappers, new ContextWrappers()],
  ].map(([service, value]) => ({ token: defineService({ id: service.id, version: "1.0.0", scope: "host" }), value }));
  const host = definePlugin({ id: "scope.actual-parent", version: "1.0.0", scope: "host", provides: values.map(value => value.token),
    setup(context) { for (const { token, value } of values) context.provide(token, value); },
  });
  const app = await defineAgent({ model, plugins: [host] }).open({ store: new InMemorySessionStore() });
  t.after(() => app.close());
  for (const { token, value } of values) assert.equal(app.getService(token), value);
  assert.notEqual(app.getService(services.contextFactory), values[0].value);
  assert.notEqual(app.getService(services.permissionPolicy), values[2].value);
  assert.notEqual(app.getService(services.modelWrappers), values[3].value);
  assert.notEqual(app.getService(services.contextWrappers), values[4].value);
  const result = await (await app.submit({ input: "Reply exactly SCOPED_DEFAULTS_READY. Do not call any tools." })).result;
  assert.match(JSON.stringify(result.message), /SCOPED_DEFAULTS_READY/u);
});
