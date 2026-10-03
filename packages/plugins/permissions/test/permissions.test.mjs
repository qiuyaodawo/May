import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import test from "node:test";
import { createPermissionPlugin } from "../dist/index.js";
import { PluginHost, defineService } from "../../../plugin/dist/index.js";
import { services } from "../../../plugin-services/dist/index.js";

test("Permission plugin owns its real resource and releases it after scope closing", async () => {
  const handles = [];
  const host = await PluginHost.create({ plugins: [createPermissionPlugin({ async create(context) {
    const handle = await open(new URL("../../../../README.md", import.meta.url), "r");
    handles.push(handle); context.defer(() => handle.close());
    return async () => (await handle.stat()).isFile() ? "deny" : "allow";
  } })] });
  const first = await host.createScope("application", { id: "first" });
  const second = await host.createScope("application", { id: "second" });
  assert.equal(await first.get(services.permissionPolicy)({}), "deny");
  await first.close();
  assert.equal(handles[0].fd, -1);
  assert.ok(handles[1].fd >= 0);
  await second.close(); await host.close();
  assert.equal(handles[1].fd, -1);
});

test("factory metadata validates configuration and declares actual dependencies and state", async () => {
  const fileService = defineService({ id: "verification.policy-file", version: "1.0.0", scope: "application" });
  const handles = [];
  const resource = { id: "verification.file", version: "1.0.0", provides: [fileService], async setup(context) {
    const handle = await open(new URL("../../../../README.md", import.meta.url), "r");
    handles.push(handle); context.defer(() => handle.close()); context.provide(fileService, handle);
  } };
  const plugin = mode => createPermissionPlugin({
    config: { mode }, configSchema: { type: "object", properties: { mode: { enum: ["deny", "allow"] } }, required: ["mode"], additionalProperties: false },
    requires: [{ service: fileService, version: "^1.0.0" }], state: { version: 1, initial: { checks: 0 } },
    create(context) { return async () => {
      assert.ok((await context.get(fileService).stat()).size > 0);
      await context.state.update(value => ({ checks: value.checks + 1 }));
      return context.config.mode;
    }; },
  });
  await assert.rejects(PluginHost.create({ plugins: [resource, plugin("invalid")] }), /Invalid configuration/);
  assert.equal(handles.length, 0);
  const host = await PluginHost.create({ plugins: [plugin("deny"), resource] });
  const scope = await host.createScope("application", { id: "typed" });
  assert.equal(await scope.get(services.permissionPolicy)({}), "deny");
  assert.equal(scope.snapshotState()["may.permissions"].value.checks, 1);
  await host.close(); assert.equal(handles[0].fd, -1);
});
