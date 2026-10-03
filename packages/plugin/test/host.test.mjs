import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defineHook } from "@may/core";
import { definePlugin, defineService, PluginHost } from "../dist/index.js";

const testRoot = fileURLToPath(new URL("../.test-output/", import.meta.url));
const signal = () => new AbortController().signal;
const numberHook = defineHook({ name: "number", kind: "transform", validate(value) {
  assert.equal(typeof value, "number");
  return value;
} });
const observed = defineHook({ name: "observe", kind: "observe", validate(value) {
  assert.equal(typeof value.text, "string");
  return value;
} });
const memory = defineService({ id: "memory", version: "1.0.0", scope: "session", capabilities: ["write"] });

test("resolves required and optional services by the declared Token version", async () => {
  const first = defineService({ id: "verification.versioned-file", version: "1.0.0", scope: "application" });
  const second = defineService({ id: first.id, version: "2.0.0", scope: "application" });
  const reader = defineService({ id: "verification.versioned-reader", version: "1.0.0", scope: "application" });
  const optionalReader = defineService({ id: "verification.optional-versioned-reader", version: "1.0.0", scope: "application" });
  let handle;
  const host = await PluginHost.create({ plugins: [
    { id: "verification.reader", version: "1.0.0", provides: [reader], requires: [{ service: second }],
      setup(context) {
        const required = context.get(first);
        assert.equal(required, handle);
        context.provide(reader, async () => (await required.stat()).size);
      },
    },
    { id: "verification.optional-reader", version: "1.0.0", provides: [optionalReader], optional: [{ service: second }],
      setup(context) {
        const optional = context.optional(first);
        assert.equal(optional, handle);
        context.provide(optionalReader, async () => (await optional.stat()).size);
      },
    },
    { id: "verification.file-v2", version: "1.0.0", provides: [second], async setup(context) {
      handle = await open(new URL("../../../README.md", import.meta.url), "r");
      context.defer(() => handle.close()); context.provide(second, handle);
    } },
  ] });
  const scope = await host.createScope("application", { id: "versioned" });
  assert.ok(await scope.get(reader)() > 0);
  assert.equal(await scope.get(optionalReader)(), await scope.get(reader)());
  await host.close(); assert.equal(handle.fd, -1);
});

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function application(options) {
  const host = await PluginHost.create(options);
  const app = await host.createScope("application", { id: "app" });
  return { host, app };
}

test("validates the full graph and configurations before any setup", async () => {
  const events = new EventEmitter();
  let setups = 0;
  events.on("setup", () => setups++);
  const hostPlugin = { id: "host", version: "1.0.0", scope: "host", setup() { events.emit("setup"); } };
  const invalid = { id: "invalid", version: "1.0.0", requires: [{ service: memory }], setup() {} };
  await assert.rejects(PluginHost.create({ plugins: [hostPlugin, invalid] }), /shorter scope/);
  const missing = defineService({ id: "missing", version: "1.0.0", scope: "host" });
  await assert.rejects(PluginHost.create({ plugins: [hostPlugin, { ...invalid, requires: [{ service: missing }] }] }), /missing service/);
  await assert.rejects(PluginHost.create({ plugins: [hostPlugin, {
    id: "configuration", version: "1.0.0", config: { path: 42 },
    configSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    setup() { events.emit("setup"); },
  }] }), /Invalid configuration/);
  assert.equal(setups, 0);
});

test("rejects cycles, conflicting providers, versions and missing hook capabilities", async () => {
  const one = defineService({ id: "one", version: "1.0.0", scope: "application" });
  const two = defineService({ id: "two", version: "1.0.0", scope: "application" });
  const a = { id: "a", version: "1.0.0", provides: [one], requires: [{ service: two }], setup() {} };
  const b = { id: "b", version: "1.0.0", provides: [two], requires: [{ service: one }], setup() {} };
  await assert.rejects(PluginHost.create({ plugins: [a, b] }), /Circular/);
  await assert.rejects(PluginHost.create({ plugins: [{ ...a, requires: [] }, { ...b, provides: [one] }] }), /Duplicate service/);
  await assert.rejects(PluginHost.create({ plugins: [{ ...a, requires: [] }, { ...b, provides: [], requires: [{ service: one, version: "^2" }] }] }), /Incompatible service/);
  await assert.rejects(PluginHost.create({ plugins: [{ ...a, requires: [], requiresHooks: [numberHook] }] }), /requires hook/);
  await assert.rejects(PluginHost.create({ plugins: [{ ...a, requires: [] }, { ...b, provides: [], requires: [{ service: one, capabilities: ["write"] }] }] }), /lacks capability/);
});

test("starts dependencies in graph order and resolves declared compatible versions", async () => {
  await mkdir(testRoot, { recursive: true });
  const path = `${testRoot}/service.txt`;
  const events = [];
  const requested = defineService({ id: "file", version: "1.0.0", scope: "application" });
  const provided = defineService({ id: "file", version: "1.2.0", scope: "application", capabilities: ["write"] });
  const consumer = definePlugin({ id: "consumer", version: "1.0.0", requires: [{ service: requested, version: "^1", capabilities: ["write"] }],
    async setup(ctx) {
      events.push("consumer");
      await ctx.get(requested).write("service data");
      ctx.defer(() => { events.push("consumer closed"); });
    },
  });
  const provider = definePlugin({ id: "provider", version: "1.0.0", provides: [provided], async setup(ctx) {
    events.push("provider");
    const file = await open(path, "w+");
    ctx.defer(async () => { events.push("provider closed"); await file.close(); });
    ctx.provide(provided, { write: (text) => file.writeFile(text) });
  } });
  const { host, app } = await application({ plugins: [consumer, provider] });
  assert.equal(await readFile(path, "utf8"), "service data");
  assert.deepEqual(events, ["provider", "consumer"]);
  await app.close();
  assert.deepEqual(events, ["provider", "consumer", "consumer closed", "provider closed"]);
  await host.close();
  await rm(path);
});

test("preserves caller owned instances and rejects undeclared service access", async () => {
  const emitter = new EventEmitter();
  const token = defineService({ id: "events", version: "1.0.0", scope: "host" });
  const listener = () => {};
  emitter.on("value", listener);
  const { host, app } = await application({ plugins: [{ id: "consumer", version: "1.0.0", requires: [{ service: token }], setup(ctx) {
    assert.equal(ctx.get(token), emitter);
  } }], services: [{ service: token, value: emitter }] });
  await app.close();
  assert.equal(emitter.listenerCount("value"), 1);
  await host.close();
  emitter.off("value", listener);
  await assert.rejects(application({ plugins: [{ id: "consumer", version: "1.0.0", setup(ctx) { ctx.get(token); } }], services: [{ service: token, value: emitter }] }),
    (error) => error.cause?.message === "Plugin consumer did not declare dependency events");
});

test("keeps session state separate and saves state before exposing updates", async () => {
  await mkdir(testRoot, { recursive: true });
  const path = `${testRoot}/state.json`;
  const plugin = { id: "memory", version: "1.0.0", scope: "session", provides: [memory],
    state: { version: 1, initial: { count: 0 }, schema: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false } },
    setup(ctx) { ctx.provide(memory, ctx.state); },
  };
  const { host, app } = await application({ plugins: [plugin] });
  const one = await app.createScope("session", { id: "one", onStateChange: (snapshot) => writeFile(path, JSON.stringify(snapshot)) });
  const two = await app.createScope("session", { id: "two" });
  await Promise.all([one.get(memory).update(({ count }) => ({ count: count + 1 })), one.get(memory).update(({ count }) => ({ count: count + 1 }))]);
  assert.deepEqual(one.get(memory).get(), { count: 2 });
  assert.deepEqual(two.get(memory).get(), { count: 0 });
  const stored = JSON.parse(await readFile(path, "utf8"));
  await one.close();
  const restored = await app.createScope("session", { id: "one", state: stored });
  assert.deepEqual(restored.get(memory).get(), { count: 2 });
  await assert.rejects(restored.get(memory).set({ count: -1 }), /Invalid state/);
  assert.deepEqual(restored.get(memory).get(), { count: 2 });
  await host.close();
  await rm(path);
});

test("migrates persistent state before setup and rejects incompatible state", async () => {
  const snapshot = { memory: { pluginVersion: "1.0.0", stateVersion: 1, value: { count: 2 } } };
  const current = { id: "memory", version: "2.0.0", scope: "session", provides: [memory],
    state: { version: 2, initial: { total: 0 }, migrate: (previous) => ({ total: previous.value.count }) },
    setup(ctx) { assert.deepEqual(ctx.state.get(), { total: 2 }); ctx.provide(memory, ctx.state); },
  };
  const { host, app } = await application({ plugins: [current] });
  const migrated = await app.createScope("session", { id: "migrated", state: snapshot });
  assert.deepEqual(migrated.snapshotState(), { memory: { pluginVersion: "2.0.0", stateVersion: 2, value: { total: 2 } } });
  await host.close();
  const failing = await application({ plugins: [{ ...current, state: { version: 2, initial: { total: 0 } } }] });
  await assert.rejects(failing.app.createScope("session", { id: "incompatible", state: snapshot }), /cannot restore state/);
  await failing.host.close();
});

test("orders and validates immutable Hook transformations", async () => {
  const events = [];
  const envelope = defineHook({ name: "envelope", kind: "transform", validate(value) {
    assert.equal(typeof value.data.value, "number");
    return value;
  } });
  const { host, app } = await application({ hooks: [envelope, numberHook, observed], plugins: [
    { id: "a", version: "1.0.0", setup(ctx) {
      ctx.on(envelope, (value) => { assert.ok(Object.isFrozen(value.data)); events.push("a"); return { data: { value: value.data.value + 1 } }; }, { order: 2 });
    } },
    { id: "b", version: "1.0.0", setup(ctx) {
      ctx.on(envelope, (value) => { events.push("b"); return { data: { value: value.data.value * 2 } }; }, { order: 1 });
      ctx.on(numberHook, () => "invalid");
      ctx.on(observed, () => ({ text: "replacement" }));
    } },
  ] });
  const input = { data: { value: 3 } };
  assert.deepEqual(await app.transform(envelope, input, { signal: signal() }), { data: { value: 7 } });
  assert.deepEqual(input, { data: { value: 3 } });
  assert.deepEqual(events, ["b", "a"]);
  await assert.rejects(app.transform(numberHook, 1, { signal: signal() }), /number/);
  await assert.rejects(app.observe(observed, { text: "event" }, { signal: signal() }), /cannot return/);
  await host.close();
});

test("isolates observation failures with a mandatory error reporter", async () => {
  const errors = [];
  const { host, app } = await application({ hooks: [observed], onHookError(error, hook, pluginId) { errors.push([error.message, hook.name, pluginId]); },
    plugins: [{ id: "observer", version: "1.0.0", setup(ctx) {
      ctx.on(observed, () => { throw new Error("observer failed"); }, { failure: "isolate" });
    } }],
  });
  await app.observe(observed, { text: "event" }, { signal: signal() });
  assert.deepEqual(errors, [["observer failed", "observe", "observer"]]);
  await host.close();
  await assert.rejects(application({ hooks: [observed], plugins: [{ id: "observer", version: "1.0.0", setup(ctx) {
    ctx.on(observed, () => {}, { failure: "isolate" });
  } }] }), (error) => error.cause?.message === "Hook observe isolation requires onHookError");
});

test("cancels timed out handlers and waits for active work before resource cleanup", async () => {
  const emitter = new EventEmitter();
  let cancelled = false;
  const { host, app } = await application({ hooks: [numberHook], plugins: [{ id: "timer", version: "1.0.0", setup(ctx) {
    const listener = () => {};
    emitter.on("update", listener);
    ctx.defer(() => { emitter.off("update", listener); });
    ctx.on(numberHook, async (value, context) => {
      try { await delay(60_000, undefined, { signal: context.signal }); }
      finally { cancelled = context.signal.aborted; }
      return value;
    }, { timeoutMs: 10 });
  } }] });
  await assert.rejects(app.transform(numberHook, 1, { signal: signal() }), /timed out/);
  await host.close();
  assert.equal(cancelled, true);
  assert.equal(emitter.listenerCount("update"), 0);
});

test("unloads all acquired resources after setup failure and aggregates cleanup errors", async () => {
  const emitter = new EventEmitter();
  const events = [];
  const { host } = await application({ plugins: [] });
  await host.close();
  const first = { id: "first", version: "1.0.0", setup(ctx) {
    const listener = () => {};
    emitter.on("data", listener);
    ctx.defer(() => { emitter.off("data", listener); events.push("resource closed"); });
    ctx.defer(() => { events.push("first failed"); throw new Error("first cleanup"); });
  } };
  const second = { id: "second", version: "1.0.0", setup(ctx) {
    ctx.defer(() => { events.push("second failed"); throw new Error("second cleanup"); });
    throw new Error("setup failure");
  } };
  await assert.rejects(application({ plugins: [first, second] }), AggregateError);
  assert.equal(emitter.listenerCount("data"), 0);
  assert.deepEqual(events, ["second failed", "first failed", "resource closed"]);
});

test("waits at ancestor operation boundaries and serializes configuration changes", async () => {
  const token = defineService({ id: "value", version: "1.0.0", scope: "application" });
  const events = [];
  const plugin = { id: "value", version: "1.0.0", config: { value: 1 }, provides: [token], setup(ctx) {
    const value = ctx.config.value;
    ctx.provide(token, { value });
    events.push(`start ${value}`);
    ctx.defer(() => { events.push(`end ${value}`); });
  } };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", { id: "session" });
  const run = await session.createScope("run", { id: "run" });
  const started = gate();
  const done = gate();
  const operation = run.use(async () => { started.resolve(); await done.promise; return run.get(token).value; });
  await started.promise;
  const changeOne = app.updateConfig("value", { value: 2 });
  const changeTwo = app.updateConfig("value", { value: 3 });
  await assert.rejects(run.use(() => {}), /changing/);
  assert.deepEqual(events, ["start 1"]);
  done.resolve();
  assert.equal(await operation, 1);
  await Promise.all([changeOne, changeTwo]);
  assert.equal(run.get(token).value, 3);
  assert.deepEqual(events, ["start 1", "end 1", "start 2", "end 2", "start 3"]);
  await host.close();
});

test("validates changes before releasing services and removes dependent plugins", async () => {
  const token = defineService({ id: "value", version: "1.0.0", scope: "application" });
  const plugin = { id: "value", version: "1.0.0", provides: [token], setup(ctx) { ctx.provide(token, { value: 1 }); } };
  let closes = 0;
  const consumer = { id: "consumer", version: "1.0.0", requires: [{ service: token }], setup(ctx) {
    assert.equal(ctx.get(token).value, 1);
    ctx.defer(() => { closes++; });
  } };
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

test("cancels active work when requested and restores a failed composition explicitly", async () => {
  const started = gate();
  const ended = gate();
  const { host, app } = await application({ plugins: [] });
  const operation = app.use(async () => { started.resolve(); await ended.promise; }, { cancel: () => { ended.resolve(); } });
  await started.promise;
  await app.replacePlugins([], { cancelActive: true });
  await operation;
  await assert.rejects(app.replace({ id: "broken", version: "1.0.0", setup() { throw new Error("initialization failure"); } }), /initialization failed/);
  await assert.rejects(app.use(() => {}), /not ready/);
  await app.replacePlugins([]);
  await app.use(() => {});
  await host.close();
});

test("rejects non-JSON state and preserves previous state when durable writes fail", async () => {
  const snapshots = [];
  const plugin = { id: "state", version: "1.0.0", scope: "session", provides: [memory], state: { version: 1, initial: { count: 0 } }, setup(ctx) {
    ctx.provide(memory, ctx.state);
  } };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", { id: "session", async onStateChange(snapshot) {
    if (snapshot.state.value.count === 2) throw new Error("storage unavailable");
    snapshots.push(snapshot);
  } });
  await session.get(memory).set({ count: 1 });
  await assert.rejects(session.get(memory).set({ count: 2 }), /storage unavailable/);
  assert.deepEqual(session.get(memory).get(), { count: 1 });
  await assert.rejects(session.get(memory).set({ date: new Date() }), /JSON values/);
  await assert.rejects(session.get(memory).set({ count: Infinity }), /JSON values/);
  assert.equal(snapshots.length, 2);
  await host.close();
});

test("delivers allowAborted observations and closes sibling scopes independently", async () => {
  const completed = defineHook({ name: "completed", kind: "observe", allowAborted: true, validate: (value) => value });
  const emitter = new EventEmitter();
  const notifications = [];
  const { host, app } = await application({ hooks: [completed], plugins: [{ id: "listener", version: "1.0.0", scope: "session", setup(ctx) {
    const listener = () => { notifications.push(ctx.scopeId); };
    emitter.on("completed", listener);
    ctx.defer(() => { emitter.off("completed", listener); });
    ctx.on(completed, (_value, context) => {
      if (ctx.scopeId === "first") assert.equal(context.signal.aborted, true);
      listener();
    });
  } }] });
  const first = await app.createScope("session", { id: "first" });
  const second = await app.createScope("session", { id: "second" });
  const cancelled = new AbortController();
  cancelled.abort(new Error("run cancelled"));
  await first.observe(completed, {}, { signal: cancelled.signal });
  assert.deepEqual(notifications, ["first"]);
  await first.close();
  assert.equal(emitter.listenerCount("completed"), 1);
  await second.observe(completed, {}, { signal: signal() });
  assert.deepEqual(notifications, ["first", "second"]);
  await host.close();
  assert.equal(emitter.listenerCount("completed"), 0);
});

test("rejects asynchronous configuration schemas before setup", async () => {
  await assert.rejects(PluginHost.create({ plugins: [{ id: "async-schema", version: "1.0.0", config: {},
    configSchema: { $async: true, type: "object" }, setup() {},
  }] }), /asynchronous JSON Schema/);
});

test("does not restart Run scopes closed at a pending composition boundary", async () => {
  const events = [];
  const plugin = { id: "run-resource", version: "1.0.0", scope: "run", setup(ctx) {
    events.push(`start ${ctx.scopeId}`);
    ctx.defer(async () => {
      await delay(5);
      events.push(`end ${ctx.scopeId}`);
    });
  } };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", { id: "session" });
  const run = await session.createScope("run", { id: "run" });
  const started = gate();
  const done = gate();
  const operation = run.use(async () => { started.resolve(); await done.promise; }).finally(() => run.close());
  await started.promise;
  const replacing = app.replacePlugins([plugin]);
  done.resolve();
  await Promise.all([operation, replacing]);
  assert.equal(app.isReady, true);
  assert.equal(session.isReady, true);
  assert.equal(run.isReady, false);
  assert.deepEqual(events, ["start run", "end run"]);
  await host.close();
});

test("cleans late setup resources after cooperative timeout cancellation", async () => {
  const emitter = new EventEmitter();
  const listener = () => {};
  const host = await PluginHost.create({ timeoutMs: 10, plugins: [{ id: "late", version: "1.0.0", async setup(ctx) {
    emitter.on("data", listener);
    try {
      await delay(60_000, undefined, { signal: ctx.signal });
    } catch (error) {
      if (!ctx.signal.aborted) throw error;
    }
    return () => { emitter.off("data", listener); };
  } }] });
  await assert.rejects(host.createScope("application", { id: "late" }), /initialization failed/);
  assert.equal(emitter.listenerCount("data"), 0);
  await host.close();
});

test("external cancellation propagates during host setup", async () => {
  const cancellation = new AbortController();
  const acquired = gate();
  const emitter = new EventEmitter();
  const listener = () => {};
  const creation = PluginHost.create({ signal: cancellation.signal, plugins: [{ id: "resource", version: "1.0.0", scope: "host", async setup(ctx) {
    emitter.on("data", listener);
    ctx.defer(() => { emitter.off("data", listener); });
    acquired.resolve();
    await delay(60_000, undefined, { signal: ctx.signal });
  } }] });
  await acquired.promise;
  cancellation.abort(new Error("host setup cancelled"));
  await assert.rejects(creation, /initialization failed/);
  assert.equal(emitter.listenerCount("data"), 0);
});

test("captures configuration at creation and applies explicit updates", async () => {
  const values = [];
  const config = { count: 1 };
  const plugin = { id: "config", version: "1.0.0", config,
    configSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
    setup(ctx) { values.push(ctx.config.count); },
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
  const provider = { id: "host-provider", version: "1.0.0", scope: "host", provides: [service], setup(ctx) {
    ctx.provide(service, { value: 1 });
    ctx.defer(() => { events.push("host cleanup"); });
  } };
  const { host, app } = await application({ plugins: [provider] });
  app.validatePlugins([provider]);
  assert.equal(app.isReady, true);
  assert.deepEqual(events, []);
  assert.throws(() => app.validatePlugins([]), /ancestor plugins/);
  assert.throws(() => app.validatePlugins([provider, { id: "missing", version: "1.0.0", requires: [{ service: memory }], setup() {} }]), /shorter scope/);
  await app.close();
  assert.deepEqual(events, []);
  await host.close();
  assert.deepEqual(events, ["host cleanup"]);
});

test("scope initialization receives a caller cancellation signal", async () => {
  const entered = gate();
  const cancellation = new AbortController();
  const emitter = new EventEmitter();
  const { host, app } = await application({ plugins: [{ id: "run-setup", version: "1.0.0", scope: "run", async setup(ctx) {
    const listener = () => {};
    emitter.on("run", listener);
    ctx.defer(() => { emitter.off("run", listener); });
    entered.resolve();
    await delay(60_000, undefined, { signal: ctx.signal });
  } }] });
  const session = await app.createScope("session", { id: "session" });
  const creating = session.createScope("run", { id: "run", signal: cancellation.signal });
  await entered.promise;
  cancellation.abort(new Error("Run startup cancelled"));
  await assert.rejects(creating, /initialization failed/);
  assert.equal(emitter.listenerCount("run"), 0);
  assert.equal(session.isReady, true);
  await host.close();
});

test("error reporters receive deadlines and cancellation", async () => {
  let cancelled = false;
  const { host, app } = await application({ hooks: [observed],
    async onHookError(_error, _hook, _plugin, context) {
      try { await delay(60_000, undefined, { signal: context.signal }); }
      finally { cancelled = context.signal.aborted; }
    },
    plugins: [{ id: "observer", version: "1.0.0", setup(ctx) {
      ctx.on(observed, () => { throw new Error("observation error"); }, { failure: "isolate", timeoutMs: 10 });
    } }],
  });
  await assert.rejects(app.observe(observed, { text: "event" }, { signal: signal() }), /error reporter timed out/);
  await host.close();
  assert.equal(cancelled, true);
});
