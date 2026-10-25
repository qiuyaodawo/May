import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OpenAIResponsesModel } from "@sortedyuan/provider-openai";
import { services } from "@sortedyuan/plugin-services";
import { InMemorySessionStore } from "@sortedyuan/session";
import { AgentApplication, applicationHooks, applicationServices } from "../dist/index.js";
import { createRegistryPlugin } from "./fixtures/structural-services.ts";

test("structural registry services compile and preserve application access through replacement and disposal", async t => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
    "-p", fileURLToPath(new URL("./fixtures/tsconfig.json", import.meta.url)),
  ], { stdio: "pipe", windowsHide: true });
  const handles = [];
  const views = [];
  const contribution = version => ({
    id: "verification.file-contribution", version,
    requires: [{ service: services.toolSources }, { service: services.instructionSources }],
    async setup(context) {
      const handle = await open(new URL("../../../README.md", import.meta.url), "r");
      handles.push(handle);
      context.defer(() => handle.close());
      context.defer(context.get(services.toolSources).add(() => [{
        name: "read_size", description: "Read the open document size", inputSchema: { type: "object" },
        execute: async () => (await handle.stat()).size,
      }], { id: context.pluginId, pluginOrder: context.pluginOrder }));
      context.defer(context.get(services.instructionSources).add(() => `Document version ${version}`, { id: context.pluginId }));
    },
  });
  const observer = {
    id: "verification.access", version: "1.0.0",
    requires: [applicationServices.application, applicationServices.execution, applicationServices.history, applicationServices.state].map(service => ({ service })),
    requiresHooks: [applicationHooks.created, applicationHooks.beforeClose, applicationHooks.closed],
    setup(context) {
      if (views.length === 0) assert.throws(() => context.get(applicationServices.application).get(), /before application.created/);
      context.on(applicationHooks.created, () => {
        views.push(Object.fromEntries(["application", "execution", "history", "state"].map(name => [name, context.get(applicationServices[name]).get()])));
      });
      context.on(applicationHooks.beforeClose, async () => {
        const access = context.get(applicationServices.state).get();
        await access.recordState("verification.before-close", { saved: true });
        await assert.rejects(views[0].execution.submit({ input: "after close started" }), /closed/);
      });
      context.on(applicationHooks.closed, () => views[0].state.recordState("verification.closed", { saved: true }));
      context.defer(() => views[0].state.recordState("verification.disposed", { saved: true }));
    },
  };
  const store = new InMemorySessionStore();
  const app = await AgentApplication.open({
    store,
    model: new OpenAIResponsesModel({ apiKey: "unused-lifecycle-verification", model: "unused-lifecycle-verification" }),
    plugins: [createRegistryPlugin("1.0.0"), contribution("1.0.0"), observer],
  });
  t.after(() => app.close());
  const { application, execution, history, state } = views[0];
  assert.ok([application, execution, history, state].every(Object.isFrozen));
  assert.notEqual(application, app);
  assert.equal("close" in application, false);
  assert.equal("getService" in execution, false);
  assert.equal("submit" in history, false);
  assert.equal(execution.sessionId, app.sessionId);
  assert.equal(execution.isRunning, false);
  await state.recordState("verification.interface", { count: 1 });
  assert.equal((await history.history()).at(-1).key, "verification.interface");
  const oldRegistry = app.getService(services.toolSources);
  const tool = [...oldRegistry.snapshot()].find(tool => tool.name === "read_size");
  assert.ok(await tool.execute({}, { signal: new AbortController().signal }) > 0);
  await app.updatePlugins([createRegistryPlugin("2.0.0"), contribution("2.0.0"), observer]);
  assert.equal(handles[0].fd, -1);
  assert.deepEqual([...oldRegistry.snapshot()], []);
  assert.notEqual(application.getService(services.toolSources), oldRegistry);
  assert.match(app.getService(services.instructionSources).snapshot(), /2\.0\.0/);
  await state.recordState("verification.interface", { count: 2 });
  assert.equal((await history.history()).at(-1).value.count, 2);
  await app.close();
  assert.ok(handles.every(handle => handle.fd === -1));
  const saved = await store.read(app.sessionId);
  for (const key of ["verification.before-close", "verification.closed", "verification.disposed"]) {
    assert.equal(saved.find(event => event.type === "state.updated" && event.key === key)?.value.saved, true);
  }
  assert.throws(() => execution.isRunning, /closed/);
  assert.throws(() => state.recordState("verification.interface", {}), /closed/);
});
