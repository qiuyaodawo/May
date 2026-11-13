import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTestDirectory } from "@sortedyuan/test-support";
import { defineHook } from "@sortedyuan/may/core";
import { application, memory, numberHook, signal } from "./fixtures/host.mjs";

const observed = defineHook({
  name: "observe",
  kind: "observe",
  validate(value) {
    assert.equal(typeof value.text, "string");
    return value;
  },
});

test("keeps session state separate and saves state before exposing updates", async (t) => {
  const path = join(await createTestDirectory(t, "may/plugin-host"), "state.json");
  const plugin = {
    id: "memory",
    version: "1.0.0",
    scope: "session",
    provides: [memory],
    state: {
      version: 1,
      initial: { count: 0 },
      schema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    },
    setup(ctx) {
      ctx.provide(memory, ctx.state);
    },
  };
  const { host, app } = await application({ plugins: [plugin] });
  const one = await app.createScope("session", {
    id: "one",
    onStateChange: (snapshot) => writeFile(path, JSON.stringify(snapshot)),
  });
  const two = await app.createScope("session", { id: "two" });
  await Promise.all([
    one.get(memory).update(({ count }) => ({ count: count + 1 })),
    one.get(memory).update(({ count }) => ({ count: count + 1 })),
  ]);
  assert.deepEqual(one.get(memory).get(), { count: 2 });
  assert.deepEqual(two.get(memory).get(), { count: 0 });
  const stored = JSON.parse(await readFile(path, "utf8"));
  await one.close();
  const restored = await app.createScope("session", { id: "one", state: stored });
  assert.deepEqual(restored.get(memory).get(), { count: 2 });
  await assert.rejects(restored.get(memory).set({ count: -1 }), /Invalid state/);
  assert.deepEqual(restored.get(memory).get(), { count: 2 });
  await host.close();
});

test("migrates persistent state before setup and rejects incompatible state", async () => {
  const snapshot = { memory: { pluginVersion: "1.0.0", stateVersion: 1, value: { count: 2 } } };
  const current = {
    id: "memory",
    version: "2.0.0",
    scope: "session",
    provides: [memory],
    state: { version: 2, initial: { total: 0 }, migrate: (previous) => ({ total: previous.value.count }) },
    setup(ctx) {
      assert.deepEqual(ctx.state.get(), { total: 2 });
      ctx.provide(memory, ctx.state);
    },
  };
  const { host, app } = await application({ plugins: [current] });
  const migrated = await app.createScope("session", { id: "migrated", state: snapshot });
  assert.deepEqual(migrated.snapshotState(), {
    memory: { pluginVersion: "2.0.0", stateVersion: 2, value: { total: 2 } },
  });
  await host.close();
  const failing = await application({ plugins: [{ ...current, state: { version: 2, initial: { total: 0 } } }] });
  await assert.rejects(
    failing.app.createScope("session", { id: "incompatible", state: snapshot }),
    /cannot restore state/,
  );
  await failing.host.close();
});

test("orders and validates immutable Hook transformations", async () => {
  const events = [];
  const envelope = defineHook({
    name: "envelope",
    kind: "transform",
    validate(value) {
      assert.equal(typeof value.data.value, "number");
      return value;
    },
  });
  const { host, app } = await application({
    hooks: [envelope, numberHook, observed],
    plugins: [
      {
        id: "a",
        version: "1.0.0",
        setup(ctx) {
          ctx.on(
            envelope,
            (value) => {
              assert.ok(Object.isFrozen(value.data));
              events.push("a");
              return { data: { value: value.data.value + 1 } };
            },
            { order: 2 },
          );
        },
      },
      {
        id: "b",
        version: "1.0.0",
        setup(ctx) {
          ctx.on(
            envelope,
            (value) => {
              events.push("b");
              return { data: { value: value.data.value * 2 } };
            },
            { order: 1 },
          );
          ctx.on(numberHook, () => "invalid");
          ctx.on(observed, () => ({ text: "replacement" }));
        },
      },
    ],
  });
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
  const { host, app } = await application({
    hooks: [observed],
    onHookError(error, hook, pluginId) {
      errors.push([error.message, hook.name, pluginId]);
    },
    plugins: [
      {
        id: "observer",
        version: "1.0.0",
        setup(ctx) {
          ctx.on(
            observed,
            () => {
              throw new Error("observer failed");
            },
            { failure: "isolate" },
          );
        },
      },
    ],
  });
  await app.observe(observed, { text: "event" }, { signal: signal() });
  assert.deepEqual(errors, [["observer failed", "observe", "observer"]]);
  await host.close();
  await assert.rejects(
    application({
      hooks: [observed],
      plugins: [
        {
          id: "observer",
          version: "1.0.0",
          setup(ctx) {
            ctx.on(observed, () => {}, { failure: "isolate" });
          },
        },
      ],
    }),
    (error) => error.cause?.message === "Hook observe isolation requires onHookError",
  );
});

test("rejects non-JSON state and preserves previous state when durable writes fail", async () => {
  const snapshots = [];
  const plugin = {
    id: "state",
    version: "1.0.0",
    scope: "session",
    provides: [memory],
    state: { version: 1, initial: { count: 0 } },
    setup(ctx) {
      ctx.provide(memory, ctx.state);
    },
  };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", {
    id: "session",
    async onStateChange(snapshot) {
      if (snapshot.state.value.count === 2) throw new Error("storage unavailable");
      snapshots.push(snapshot);
    },
  });
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
  const { host, app } = await application({
    hooks: [completed],
    plugins: [
      {
        id: "listener",
        version: "1.0.0",
        scope: "session",
        setup(ctx) {
          const listener = () => {
            notifications.push(ctx.scopeId);
          };
          emitter.on("completed", listener);
          ctx.defer(() => {
            emitter.off("completed", listener);
          });
          ctx.on(completed, (_value, context) => {
            if (ctx.scopeId === "first") assert.equal(context.signal.aborted, true);
            listener();
          });
        },
      },
    ],
  });
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

test("error reporters receive deadlines and cancellation", async () => {
  let cancelled = false;
  const { host, app } = await application({
    hooks: [observed],
    async onHookError(_error, _hook, _plugin, context) {
      try {
        await delay(60_000, undefined, { signal: context.signal });
      } finally {
        cancelled = context.signal.aborted;
      }
    },
    plugins: [
      {
        id: "observer",
        version: "1.0.0",
        setup(ctx) {
          ctx.on(
            observed,
            () => {
              throw new Error("observation error");
            },
            { failure: "isolate", timeoutMs: 10 },
          );
        },
      },
    ],
  });
  await assert.rejects(app.observe(observed, { text: "event" }, { signal: signal() }), /error reporter timed out/);
  await host.close();
  assert.equal(cancelled, true);
});
