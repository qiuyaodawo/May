import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestDirectory } from "@sortedyuan/test-support";
import { definePlugin, defineService, PluginHost } from "@sortedyuan/may/plugin";
import { application, memory, numberHook } from "./fixtures/host.mjs";

test("resolves required and optional services by the declared Token version", async () => {
  const first = defineService({ id: "verification.versioned-file", version: "1.0.0", scope: "application" });
  const second = defineService({ id: first.id, version: "2.0.0", scope: "application" });
  const reader = defineService({ id: "verification.versioned-reader", version: "1.0.0", scope: "application" });
  const optionalReader = defineService({
    id: "verification.optional-versioned-reader",
    version: "1.0.0",
    scope: "application",
  });
  let handle;
  const host = await PluginHost.create({
    plugins: [
      {
        id: "verification.reader",
        version: "1.0.0",
        provides: [reader],
        requires: [{ service: second }],
        setup(context) {
          const required = context.get(first);
          assert.equal(required, handle);
          context.provide(reader, async () => (await required.stat()).size);
        },
      },
      {
        id: "verification.optional-reader",
        version: "1.0.0",
        provides: [optionalReader],
        optional: [{ service: second }],
        setup(context) {
          const optional = context.optional(first);
          assert.equal(optional, handle);
          context.provide(optionalReader, async () => (await optional.stat()).size);
        },
      },
      {
        id: "verification.file-v2",
        version: "1.0.0",
        provides: [second],
        async setup(context) {
          handle = await open(new URL("../../../../README.md", import.meta.url), "r");
          context.defer(() => handle.close());
          context.provide(second, handle);
        },
      },
    ],
  });
  const scope = await host.createScope("application", { id: "versioned" });
  assert.ok((await scope.get(reader)()) > 0);
  assert.equal(await scope.get(optionalReader)(), await scope.get(reader)());
  await host.close();
  assert.equal(handle.fd, -1);
});

test("validates the full graph and configurations before any setup", async () => {
  const events = new EventEmitter();
  let setups = 0;
  events.on("setup", () => setups++);
  const hostPlugin = {
    id: "host",
    version: "1.0.0",
    scope: "host",
    setup() {
      events.emit("setup");
    },
  };
  const invalid = { id: "invalid", version: "1.0.0", requires: [{ service: memory }], setup() {} };
  await assert.rejects(PluginHost.create({ plugins: [hostPlugin, invalid] }), /shorter scope/);
  const missing = defineService({ id: "missing", version: "1.0.0", scope: "host" });
  await assert.rejects(
    PluginHost.create({ plugins: [hostPlugin, { ...invalid, requires: [{ service: missing }] }] }),
    /missing service/,
  );
  await assert.rejects(
    PluginHost.create({
      plugins: [
        hostPlugin,
        {
          id: "configuration",
          version: "1.0.0",
          config: { path: 42 },
          configSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          setup() {
            events.emit("setup");
          },
        },
      ],
    }),
    /Invalid configuration/,
  );
  assert.equal(setups, 0);
});

test("rejects cycles, conflicting providers, versions and missing hook capabilities", async () => {
  const one = defineService({ id: "one", version: "1.0.0", scope: "application" });
  const two = defineService({ id: "two", version: "1.0.0", scope: "application" });
  const a = { id: "a", version: "1.0.0", provides: [one], requires: [{ service: two }], setup() {} };
  const b = { id: "b", version: "1.0.0", provides: [two], requires: [{ service: one }], setup() {} };
  await assert.rejects(PluginHost.create({ plugins: [a, b] }), /Circular/);
  await assert.rejects(
    PluginHost.create({
      plugins: [
        { ...a, requires: [] },
        { ...b, provides: [one] },
      ],
    }),
    /Duplicate service/,
  );
  await assert.rejects(
    PluginHost.create({
      plugins: [
        { ...a, requires: [] },
        { ...b, provides: [], requires: [{ service: one, version: "^2" }] },
      ],
    }),
    /Incompatible service/,
  );
  await assert.rejects(
    PluginHost.create({ plugins: [{ ...a, requires: [], requiresHooks: [numberHook] }] }),
    /requires hook/,
  );
  await assert.rejects(
    PluginHost.create({
      plugins: [
        { ...a, requires: [] },
        { ...b, provides: [], requires: [{ service: one, capabilities: ["write"] }] },
      ],
    }),
    /lacks capability/,
  );
});

test("starts dependencies in graph order and resolves declared compatible versions", async (t) => {
  const path = join(await createTestDirectory(t, "may/plugin-host"), "service.txt");
  const events = [];
  const requested = defineService({ id: "file", version: "1.0.0", scope: "application" });
  const provided = defineService({ id: "file", version: "1.2.0", scope: "application", capabilities: ["write"] });
  const consumer = definePlugin({
    id: "consumer",
    version: "1.0.0",
    requires: [{ service: requested, version: "^1", capabilities: ["write"] }],
    async setup(ctx) {
      events.push("consumer");
      await ctx.get(requested).write("service data");
      ctx.defer(() => {
        events.push("consumer closed");
      });
    },
  });
  const provider = definePlugin({
    id: "provider",
    version: "1.0.0",
    provides: [provided],
    async setup(ctx) {
      events.push("provider");
      const file = await open(path, "w+");
      ctx.defer(async () => {
        events.push("provider closed");
        await file.close();
      });
      ctx.provide(provided, { write: (text) => file.writeFile(text) });
    },
  });
  const { host, app } = await application({ plugins: [consumer, provider] });
  assert.equal(await readFile(path, "utf8"), "service data");
  assert.deepEqual(events, ["provider", "consumer"]);
  await app.close();
  assert.deepEqual(events, ["provider", "consumer", "consumer closed", "provider closed"]);
  await host.close();
});

test("preserves caller owned instances and rejects undeclared service access", async () => {
  const emitter = new EventEmitter();
  const token = defineService({ id: "events", version: "1.0.0", scope: "host" });
  const listener = () => {};
  emitter.on("value", listener);
  const { host, app } = await application({
    plugins: [
      {
        id: "consumer",
        version: "1.0.0",
        requires: [{ service: token }],
        setup(ctx) {
          assert.equal(ctx.get(token), emitter);
        },
      },
    ],
    services: [{ service: token, value: emitter }],
  });
  await app.close();
  assert.equal(emitter.listenerCount("value"), 1);
  await host.close();
  emitter.off("value", listener);
  await assert.rejects(
    application({
      plugins: [
        {
          id: "consumer",
          version: "1.0.0",
          setup(ctx) {
            ctx.get(token);
          },
        },
      ],
      services: [{ service: token, value: emitter }],
    }),
    (error) => error.cause?.message === "Plugin consumer did not declare dependency events",
  );
});

test("validates changes before releasing services and removes dependent plugins", async () => {
  const token = defineService({ id: "value", version: "1.0.0", scope: "application" });
  const plugin = {
    id: "value",
    version: "1.0.0",
    provides: [token],
    setup(ctx) {
      ctx.provide(token, { value: 1 });
    },
  };
  let closes = 0;
  const consumer = {
    id: "consumer",
    version: "1.0.0",
    requires: [{ service: token }],
    setup(ctx) {
      assert.equal(ctx.get(token).value, 1);
      ctx.defer(() => {
        closes++;
      });
    },
  };
  const { host, app } = await application({ plugins: [plugin, consumer] });
  const before = app.get(token);
  await assert.rejects(app.replacePlugins([consumer]), /missing service/);
  assert.equal(app.get(token), before);
  assert.equal(closes, 0);
  await app.remove("value");
  assert.equal(app.provides(token), false);
  assert.deepEqual(app.plugins, []);
  assert.equal(closes, 1);
  await host.close();
});

test("rejects asynchronous configuration schemas before setup", async () => {
  await assert.rejects(
    PluginHost.create({
      plugins: [
        {
          id: "async-schema",
          version: "1.0.0",
          config: {},
          configSchema: { $async: true, type: "object" },
          setup() {},
        },
      ],
    }),
    /asynchronous JSON Schema/,
  );
});

test("captures configuration at creation and applies explicit updates", async () => {
  const values = [];
  const config = { count: 1 };
  const plugin = {
    id: "config",
    version: "1.0.0",
    config,
    configSchema: {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    },
    setup(ctx) {
      values.push(ctx.config.count);
    },
  };
  const host = await PluginHost.create({ plugins: [plugin] });
  config.count = "invalid";
  const app = await host.createScope("application", { id: "application" });
  assert.deepEqual(values, [1]);
  await app.updateConfig("config", { count: 2 });
  assert.deepEqual(values, [1, 2]);
  await host.close();
});

test("prevalidates scope changes without starting or releasing resources", async () => {
  const events = [];
  const service = defineService({ id: "required", version: "1.0.0", scope: "host" });
  const provider = {
    id: "host-provider",
    version: "1.0.0",
    scope: "host",
    provides: [service],
    setup(ctx) {
      ctx.provide(service, { value: 1 });
      ctx.defer(() => {
        events.push("host cleanup");
      });
    },
  };
  const { host, app } = await application({ plugins: [provider] });
  app.validatePlugins([provider]);
  assert.equal(app.isReady, true);
  assert.deepEqual(events, []);
  assert.throws(() => app.validatePlugins([]), /ancestor plugins/);
  assert.throws(
    () =>
      app.validatePlugins([provider, { id: "missing", version: "1.0.0", requires: [{ service: memory }], setup() {} }]),
    /shorter scope/,
  );
  await app.close();
  assert.deepEqual(events, []);
  await host.close();
  assert.deepEqual(events, ["host cleanup"]);
});
