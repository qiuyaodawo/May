import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { AgentApplication, applicationHooks, applicationServices, PLUGIN_STATE_KEY } from "@sortedyuan/may";
import { May, runtimeHooks } from "@sortedyuan/may/core";
import { defineService } from "@sortedyuan/may/plugin";
import { InMemorySessionStore } from "@sortedyuan/may/session";

import { createModel, documentPath } from "../fixtures/live-model.mjs";

const counterService = defineService({ id: "verification.counter", version: "1.0.0", scope: "application" });

function statePlugin(resources, options = {}) {
  return {
    id: "verification.lifecycle",
    version: options.version ?? "1.0.0",
    provides: [counterService],
    requiresHooks: [runtimeHooks.runBefore],
    state: {
      version: options.stateVersion ?? 1,
      initial: { count: 0 },
      schema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
    },
    async setup(ctx) {
      const handle = await open(documentPath, "r");
      resources.push(handle);
      ctx.defer(() => handle.close());
      ctx.provide(counterService, {
        count: () => ctx.state.get().count,
        increment: () => ctx.state.update((value) => ({ count: value.count + 1 })),
      });
      ctx.on(runtimeHooks.runBefore, () => ctx.state.update((value) => ({ count: value.count + 1 })));
      ctx.on(applicationHooks.inputBeforeSubmit, (value) => ({ ...value, input: `${value.input}\nAnswer briefly.` }));
    },
  };
}

test(
  "one plugin serves independent applications and restores migrated Session state with a real provider",
  { timeout: 120_000 },
  async (t) => {
    const resources = [];
    const plugin = statePlugin(resources);
    const model = await createModel();
    const store = new InMemorySessionStore();
    const first = await AgentApplication.open({ model, store, permissionPolicy: () => "deny", plugins: [plugin] });
    const second = await AgentApplication.open({ model, store, permissionPolicy: () => "deny", plugins: [plugin] });
    t.after(async () => {
      await first.close();
      await second.close();
    });
    await (
      await first.submit({ input: "Reply with exactly PLUGIN_READY." })
    ).result;
    assert.equal(first.getService(counterService).count(), 1);
    assert.equal(second.getService(counterService).count(), 0);
    const history = await first.history();
    assert.match(history.find((event) => event.type === "input.submitted").message.content[0].text, /Answer briefly/);
    const saved = history.filter((event) => event.type === "state.updated" && event.key === PLUGIN_STATE_KEY).at(-1);
    assert.equal(saved.value.application[plugin.id].value.count, 1);
    const sessionId = first.sessionId;
    await first.close();
    assert.equal(resources[0].fd, -1);
    const migrated = statePlugin(resources, {
      version: "2.0.0",
      stateVersion: 2,
      migrate: (previous) => ({ count: previous.value.count + 10 }),
    });
    const resumed = await AgentApplication.open({
      model,
      store,
      permissionPolicy: () => "deny",
      sessionId,
      resume: true,
      plugins: [migrated],
    });
    t.after(() => resumed.close());
    assert.equal(resumed.getService(counterService).count(), 11);
    await (
      await resumed.continue()
    ).result;
    assert.equal(resumed.getService(counterService).count(), 12);
    assert.equal((await resumed.history()).filter((event) => event.type === "input.submitted").length, 1);
    await resumed.close();
    await second.close();
    assert.ok(resources.every((handle) => handle.fd === -1));
  },
);

test(
  "application and Session plugin state updates retain both committed scope values",
  { timeout: 15_000 },
  async (t) => {
    const service = defineService({ id: "verification.session-counter", version: "1.0.0", scope: "session" });
    const sessionPlugin = {
      id: "verification.session-state",
      version: "1.0.0",
      scope: "session",
      provides: [service],
      state: { version: 1, initial: { count: 0 } },
      setup(ctx) {
        ctx.provide(service, { increment: () => ctx.state.update((value) => ({ count: value.count + 1 })) });
      },
    };
    const app = await AgentApplication.open({
      model: await createModel(),
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [statePlugin([]), sessionPlugin],
    });
    t.after(() => app.close());
    await Promise.all([app.getService(counterService).increment(), app.getService(service).increment()]);
    const saved = (await app.history())
      .filter((event) => event.type === "state.updated" && event.key === PLUGIN_STATE_KEY)
      .at(-1);
    assert.equal(saved.value.application["verification.lifecycle"].value.count, 1);
    assert.equal(saved.value.session[sessionPlugin.id].value.count, 1);
  },
);

test(
  "runtime service replacements apply at a Run boundary and invalid dependency graphs preserve the active configuration",
  { timeout: 120_000 },
  async (t) => {
    const model = await createModel();
    let created = 0;
    const resources = [];
    let activeRuntime;
    const createRuntimePlugin = (version = 1) => ({
      id: "verification.runtime",
      version: `${version}.0.0`,
      provides: [applicationServices.runtimeFactory],
      state: { version: 1, initial: { closed: 0 }, compatibleVersions: "*" },
      setup(ctx) {
        ctx.provide(applicationServices.runtimeFactory, async (options) => {
          created += 1;
          const loop = new May({ ...options, maxSteps: 4 });
          const handle = await open(documentPath, "r");
          resources.push(handle);
          let calls = 0;
          let closed = 0;
          activeRuntime = {
            descriptor: {
              id: version === 3 ? "verification.incompatible" : "verification.loop",
              version: String(version),
              stateVersion: version,
            },
            supportedHooks: loop.supportedHooks,
            supportsRequestRecording: loop.supportsRequestRecording,
            run(options) {
              calls += 1;
              return loop.run(options);
            },
            continue(options) {
              calls += 1;
              return loop.continue(options);
            },
            appendMessages: (messages) => loop.appendMessages(messages),
            saveState() {
              ctx.state.get();
              return { calls };
            },
            restoreState(state) {
              calls = state.calls;
            },
            ...(version === 3
              ? {}
              : {
                  migrateState(descriptor, state) {
                    return { calls: (state?.calls ?? 0) + (version === 2 ? 10 : 0) };
                  },
                }),
            async close() {
              closed += 1;
              assert.equal(closed, 1);
              await ctx.state.update((value) => ({ closed: value.closed + 1 }));
              await handle.close();
            },
          };
          return activeRuntime;
        });
      },
    });
    const runtimePlugin = createRuntimePlugin();
    const app = await AgentApplication.open({
      model,
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
    });
    t.after(() => app.close());
    const run = await app.submit({ input: "Reply with exactly RUNTIME_READY." });
    const updated = app.updatePlugins([runtimePlugin]);
    await assert.rejects(app.continue(), /active/);
    await run.result;
    await updated;
    assert.equal(created, 1);
    await (
      await app.continue()
    ).result;
    assert.equal(activeRuntime.saveState().calls, 1);
    await app.updatePlugins([createRuntimePlugin(2)]);
    assert.equal(resources[0].fd, -1);
    assert.equal(activeRuntime.saveState().calls, 11);
    const absent = defineService({ id: "verification.absent", version: "1.0.0", scope: "application" });
    await assert.rejects(
      app.updatePlugins([
        { id: "verification.invalid", version: "1.0.0", requires: [{ service: absent }], setup() {} },
      ]),
      /Missing|required|missing/,
    );
    assert.equal(app.isRunning, false);
    await (
      await app.continue()
    ).result;
    assert.equal(activeRuntime.saveState().calls, 12);
    assert.equal(created, 2);
    assert.equal((await app.history()).filter((event) => event.type === "runtime.changed").length, 2);
    await assert.rejects(app.updatePlugins([createRuntimePlugin(3)]), /incompatible/);
    await assert.rejects(app.continue(), /unavailable/);
    assert.equal(resources[2].fd, -1);
    await app.updatePlugins([createRuntimePlugin(4)]);
    assert.equal(activeRuntime.saveState().calls, 12);
    await (
      await app.continue()
    ).result;
    assert.equal(activeRuntime.saveState().calls, 13);
    assert.equal(created, 4);
    await app.close();
    assert.ok(resources.every((handle) => handle.fd === -1));
  },
);

test(
  "input Hooks receive cancellation and application cleanup closes actual resources",
  { timeout: 15_000 },
  async (t) => {
    let entered;
    let waiting = new Promise((resolve) => {
      entered = resolve;
    });
    let handle;
    const plugin = {
      id: "verification.input-cancellation",
      version: "1.0.0",
      async setup(ctx) {
        handle = await open(documentPath, "r");
        ctx.defer(() => handle.close());
        ctx.on(applicationHooks.inputBeforeSubmit, async (value, context) => {
          entered();
          await setTimeout(30_000, undefined, { signal: context.signal });
          return value;
        });
      },
    };
    const app = await AgentApplication.open({
      model: await createModel(),
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [plugin],
    });
    t.after(() => app.close());
    const controller = new AbortController();
    const submitting = app.submit({ input: "No model request should start.", signal: controller.signal });
    const rejected = assert.rejects(submitting, /abort|cancel/i);
    await waiting;
    controller.abort(new Error("Input cancelled"));
    await rejected;
    assert.equal(
      (await app.history()).some((event) => event.type === "run.started"),
      false,
    );
    await app.close();
    assert.equal(handle.fd, -1);
    waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const closing = await AgentApplication.open({
      model: await createModel(),
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [plugin],
    });
    t.after(() => closing.close());
    const pending = closing.submit({ input: "Application close cancels this handler." });
    const closedSubmission = assert.rejects(pending, /closed/);
    await waiting;
    await closing.close();
    await closedSubmission;
    assert.equal(handle.fd, -1);
  },
);

test(
  "caller cancellation stops Run plugin initialization and closes acquired resources",
  { timeout: 15_000 },
  async (t) => {
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let handle;
    const app = await AgentApplication.open({
      model: await createModel(),
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [
        {
          id: "verification.run-startup",
          version: "1.0.0",
          scope: "run",
          async setup(ctx) {
            handle = await open(documentPath, "r");
            ctx.defer(() => handle.close());
            entered();
            await setTimeout(30_000, undefined, { signal: ctx.signal });
          },
        },
      ],
    });
    t.after(() => app.close());
    const controller = new AbortController();
    const submission = app.submit({ input: "No model request should start.", signal: controller.signal });
    const rejected = assert.rejects(submission, /cancel|initialization/i);
    await started;
    controller.abort(new Error("Run setup cancelled"));
    await rejected;
    assert.equal(handle.fd, -1);
    assert.equal(
      (await app.history()).some((event) => event.type === "input.submitted"),
      false,
    );
  },
);
