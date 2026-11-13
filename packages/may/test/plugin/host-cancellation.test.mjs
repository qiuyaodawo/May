import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { defineService, PluginHost } from "@sortedyuan/may/plugin";
import { application, numberHook, signal } from "./fixtures/host.mjs";

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cancels timed out handlers and waits for active work before resource cleanup", async () => {
  const emitter = new EventEmitter();
  let cancelled = false;
  const { host, app } = await application({
    hooks: [numberHook],
    plugins: [
      {
        id: "timer",
        version: "1.0.0",
        setup(ctx) {
          const listener = () => {};
          emitter.on("update", listener);
          ctx.defer(() => {
            emitter.off("update", listener);
          });
          ctx.on(
            numberHook,
            async (value, context) => {
              try {
                await delay(60_000, undefined, { signal: context.signal });
              } finally {
                cancelled = context.signal.aborted;
              }
              return value;
            },
            { timeoutMs: 10 },
          );
        },
      },
    ],
  });
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
  const first = {
    id: "first",
    version: "1.0.0",
    setup(ctx) {
      const listener = () => {};
      emitter.on("data", listener);
      ctx.defer(() => {
        emitter.off("data", listener);
        events.push("resource closed");
      });
      ctx.defer(() => {
        events.push("first failed");
        throw new Error("first cleanup");
      });
    },
  };
  const second = {
    id: "second",
    version: "1.0.0",
    setup(ctx) {
      ctx.defer(() => {
        events.push("second failed");
        throw new Error("second cleanup");
      });
      throw new Error("setup failure");
    },
  };
  await assert.rejects(application({ plugins: [first, second] }), AggregateError);
  assert.equal(emitter.listenerCount("data"), 0);
  assert.deepEqual(events, ["second failed", "first failed", "resource closed"]);
});

test("waits at ancestor operation boundaries and serializes configuration changes", async () => {
  const token = defineService({ id: "value", version: "1.0.0", scope: "application" });
  const events = [];
  const plugin = {
    id: "value",
    version: "1.0.0",
    config: { value: 1 },
    provides: [token],
    setup(ctx) {
      const value = ctx.config.value;
      ctx.provide(token, { value });
      events.push(`start ${value}`);
      ctx.defer(() => {
        events.push(`end ${value}`);
      });
    },
  };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", { id: "session" });
  const run = await session.createScope("run", { id: "run" });
  const started = gate();
  const done = gate();
  const operation = run.use(async () => {
    started.resolve();
    await done.promise;
    return run.get(token).value;
  });
  await started.promise;
  const changeOne = app.updateConfig("value", { value: 2 });
  const changeTwo = app.updateConfig("value", { value: 3 });
  await assert.rejects(
    run.use(() => {}),
    /changing/,
  );
  assert.deepEqual(events, ["start 1"]);
  done.resolve();
  assert.equal(await operation, 1);
  await Promise.all([changeOne, changeTwo]);
  assert.equal(run.get(token).value, 3);
  assert.deepEqual(events, ["start 1", "end 1", "start 2", "end 2", "start 3"]);
  await host.close();
});

test("cancels active work when requested and restores a failed composition explicitly", async () => {
  const started = gate();
  const ended = gate();
  const { host, app } = await application({ plugins: [] });
  const operation = app.use(
    async () => {
      started.resolve();
      await ended.promise;
    },
    {
      cancel: () => {
        ended.resolve();
      },
    },
  );
  await started.promise;
  await app.replacePlugins([], { cancelActive: true });
  await operation;
  await assert.rejects(
    app.replace({
      id: "broken",
      version: "1.0.0",
      setup() {
        throw new Error("initialization failure");
      },
    }),
    /initialization failed/,
  );
  await assert.rejects(
    app.use(() => {}),
    /not ready/,
  );
  await app.replacePlugins([]);
  await app.use(() => {});
  await host.close();
});

test("does not restart Run scopes closed at a pending composition boundary", async () => {
  const events = [];
  const plugin = {
    id: "run-resource",
    version: "1.0.0",
    scope: "run",
    setup(ctx) {
      events.push(`start ${ctx.scopeId}`);
      ctx.defer(async () => {
        await delay(5);
        events.push(`end ${ctx.scopeId}`);
      });
    },
  };
  const { host, app } = await application({ plugins: [plugin] });
  const session = await app.createScope("session", { id: "session" });
  const run = await session.createScope("run", { id: "run" });
  const started = gate();
  const done = gate();
  const operation = run
    .use(async () => {
      started.resolve();
      await done.promise;
    })
    .finally(() => run.close());
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
  const host = await PluginHost.create({
    timeoutMs: 10,
    plugins: [
      {
        id: "late",
        version: "1.0.0",
        async setup(ctx) {
          emitter.on("data", listener);
          try {
            await delay(60_000, undefined, { signal: ctx.signal });
          } catch (error) {
            if (!ctx.signal.aborted) throw error;
          }
          return () => {
            emitter.off("data", listener);
          };
        },
      },
    ],
  });
  await assert.rejects(host.createScope("application", { id: "late" }), /initialization failed/);
  assert.equal(emitter.listenerCount("data"), 0);
  await host.close();
});

test("external cancellation propagates during host setup", async () => {
  const cancellation = new AbortController();
  const acquired = gate();
  const emitter = new EventEmitter();
  const listener = () => {};
  const creation = PluginHost.create({
    signal: cancellation.signal,
    plugins: [
      {
        id: "resource",
        version: "1.0.0",
        scope: "host",
        async setup(ctx) {
          emitter.on("data", listener);
          ctx.defer(() => {
            emitter.off("data", listener);
          });
          acquired.resolve();
          await delay(60_000, undefined, { signal: ctx.signal });
        },
      },
    ],
  });
  await acquired.promise;
  cancellation.abort(new Error("host setup cancelled"));
  await assert.rejects(creation, /initialization failed/);
  assert.equal(emitter.listenerCount("data"), 0);
});

test("scope initialization receives a caller cancellation signal", async () => {
  const entered = gate();
  const cancellation = new AbortController();
  const emitter = new EventEmitter();
  const { host, app } = await application({
    plugins: [
      {
        id: "run-setup",
        version: "1.0.0",
        scope: "run",
        async setup(ctx) {
          const listener = () => {};
          emitter.on("run", listener);
          ctx.defer(() => {
            emitter.off("run", listener);
          });
          entered.resolve();
          await delay(60_000, undefined, { signal: ctx.signal });
        },
      },
    ],
  });
  const session = await app.createScope("session", { id: "session" });
  const creating = session.createScope("run", { id: "run", signal: cancellation.signal });
  await entered.promise;
  cancellation.abort(new Error("Run startup cancelled"));
  await assert.rejects(creating, /initialization failed/);
  assert.equal(emitter.listenerCount("run"), 0);
  assert.equal(session.isReady, true);
  await host.close();
});
