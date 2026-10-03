import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import test from "node:test";
import { AgentApplication, applicationHooks, applicationServices, defineAgent } from "../../dist/index.js";
import { createModelPlugin, createModelWrapperPlugin } from "../../../plugins/models/dist/index.js";
import { createPermissionPlugin } from "../../../plugins/permissions/dist/index.js";
import { createContextWrapperPlugin, createToolsPlugin } from "../../../plugins/runtime/dist/index.js";
import { defineService } from "../../../plugin/dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";
import { loadMayConfig } from "../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../providers/dist/index.js";
import { BasicTracer, InMemorySpanProcessor } from "../../../observability/dist/index.js";

async function createModel() {
  return createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" }));
}

test("plugin factories compose real Model, Context, tools and actual application access independently", { timeout: 120_000 }, async t => {
  const resources = [], calls = [], contexts = [], attached = [];
  const actualModel = await createModel();
  const resourcesService = defineService({ id: "verification.resources", version: "1.0.0", scope: "application" });
  const owner = {
    id: "verification.owner", version: "1.0.0", provides: [resourcesService],
    requires: [{ service: applicationServices.application }],
    state: { version: 1, initial: { attached: 0 } },
    async setup(context) {
      const handle = await open(new URL("../../../../README.md", import.meta.url), "r");
      resources.push(handle); context.defer(() => handle.close());
      context.provide(resourcesService, { handle, attached: () => context.state.get().attached });
      context.on(applicationHooks.created, async () => {
        attached.push(context.get(applicationServices.application).get());
        await context.state.update(value => ({ attached: value.attached + 1 }));
      });
    },
  };
  const wrapper = (id, order) => createModelWrapperPlugin({ id, order, create: context => model => ({
    limits: model.limits, contextCompactor: model.contextCompactor,
    async *stream(request, options) {
      calls.push(`${context.scopeId}:${id}`);
      yield* model.stream(request, options);
    },
  }) });
  const contextWrapper = (id, order) => createContextWrapperPlugin({ id, order, create: context => factory => ({
    create(options) { contexts.push(`${context.scopeId}:${id}`); return factory.create(options); },
  }) });
  const tools = id => createToolsPlugin({ id, async create(context) {
    const handle = await open(new URL("../../../../package.json", import.meta.url), "r");
    resources.push(handle); context.defer(() => handle.close());
    return () => [{ name: id, description: "Read actual repository file size", inputSchema: { type: "object", additionalProperties: false }, async execute() { return (await handle.stat()).size; } }];
  } });
  const plugins = [
    wrapper("verification.inner", 10), wrapper("verification.outer", 20),
    contextWrapper("verification.context-inner", 10), contextWrapper("verification.context-outer", 20),
    tools("file_one"), tools("file_two"), owner,
    createModelPlugin({ create: () => actualModel }), createPermissionPlugin({ create: () => () => "allow" }),
  ];
  const store = new InMemorySessionStore();
  const definition = defineAgent({ plugins, instructions: "Answer briefly." });
  const first = await definition.open({ store });
  const second = await definition.open({ store });
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal(attached[0], first); assert.equal(attached[1], second);
  assert.notEqual(first.getService(resourcesService), second.getService(resourcesService));
  assert.deepEqual(contexts.slice(0, 2), [`${first.sessionId}:verification.context-outer`, `${first.sessionId}:verification.context-inner`]);
  const catalog = first.getService(applicationServices.toolSources).snapshot();
  assert.deepEqual(catalog.names(), ["file_one", "file_two"]);
  assert.ok(await catalog.require("file_one").execute({}) > 0);
  await (await first.submit({ input: "Reply with PLUGIN_COMPOSITION_READY. Do not call any tool." })).result;
  assert.deepEqual(calls.slice(0, 2), [`${first.sessionId}:verification.outer`, `${first.sessionId}:verification.inner`]);
  assert.ok(calls.every(call => call.startsWith(first.sessionId)));
  await first.updatePlugins(plugins);
  assert.equal(attached.at(-1), first);
  assert.equal(first.getService(resourcesService).attached(), 2);
  assert.ok(resources.slice(0, 3).every(handle => handle.fd === -1));
  assert.ok(second.getService(resourcesService).handle.fd >= 0);
  await first.close(); await second.close();
  assert.ok(resources.every(handle => handle.fd === -1));
});

test("application access rejects setup access and cleans actual resources before returning", { timeout: 15_000 }, async () => {
  let handle;
  await assert.rejects(AgentApplication.open({ model: await createModel(), store: new InMemorySessionStore(), plugins: [{
    id: "verification.early-access", version: "1.0.0", requires: [{ service: applicationServices.application }],
    async setup(context) {
      handle = await open(new URL("../../../../README.md", import.meta.url), "r");
      context.defer(() => handle.close());
      context.get(applicationServices.application).get();
    },
  }] }), error => error.cause?.message.includes("unavailable before application.created"));
  assert.equal(handle.fd, -1);
});

test("different plugins contributing the same tool name fail during application creation", { timeout: 15_000 }, async () => {
  const create = () => () => [{ name: "same_name", description: "Read actual documentation", inputSchema: { type: "object" },
    async execute() { const handle = await open(new URL("../../../../README.md", import.meta.url), "r"); try { return (await handle.stat()).size; } finally { await handle.close(); } },
  }];
  await assert.rejects(AgentApplication.open({ model: await createModel(), store: new InMemorySessionStore(), plugins: [
    createToolsPlugin({ id: "verification.first", create }), createToolsPlugin({ id: "verification.second", create }),
  ] }), /Duplicate tool name/);
});

test("Session plugins have prepared state before creation and receive ordered application lifecycle notifications", { timeout: 15_000 }, async () => {
  const calls = [], resources = [], attached = [];
  const observer = scope => ({
    id: `verification.lifecycle-${scope}`, version: "1.0.0", scope,
    requires: [{ service: applicationServices.application }],
    requiresHooks: [applicationHooks.beforeCreate, applicationHooks.created, applicationHooks.beforeClose, applicationHooks.closed],
    state: { version: 1, initial: { prepared: true } },
    async setup(context) {
      const handle = await open(new URL("../../../../README.md", import.meta.url), "r");
      resources.push(handle); context.defer(() => handle.close());
      context.on(applicationHooks.beforeCreate, value => {
        assert.equal(context.state.get().prepared, true);
        assert.ok(handle.fd >= 0);
        assert.throws(() => context.get(applicationServices.application).get(), /unavailable before/);
        calls.push(`${scope}:beforeCreate`);
        return { ...value, instructions: `${value.instructions ?? ""} ${scope}`.trim() };
      });
      context.on(applicationHooks.created, () => { attached.push(context.get(applicationServices.application).get()); calls.push(`${scope}:created`); });
      context.on(applicationHooks.beforeClose, async () => { assert.ok((await handle.stat()).size > 0); calls.push(`${scope}:beforeClose`); });
      context.on(applicationHooks.closed, async () => { assert.ok((await handle.stat()).size > 0); calls.push(`${scope}:closed`); });
    },
  });
  const app = await AgentApplication.open({ model: await createModel(), store: new InMemorySessionStore(), plugins: [observer("session"), observer("application")] });
  assert.deepEqual(calls, ["session:beforeCreate", "application:beforeCreate", "session:created", "application:created"]);
  assert.ok(attached.every(value => value === app));
  assert.equal((await app.inspectContext()).instructionsBytes, Buffer.byteLength("session application"));
  await app.close();
  assert.deepEqual(calls.slice(4), ["session:beforeClose", "application:beforeClose", "session:closed", "application:closed"]);
  assert.ok(resources.every(handle => handle.fd === -1));
});

test("closing plugins persist their final state before resources close and subsequent writes fail", { timeout: 15_000 }, async () => {
  const store = new InMemorySessionStore();
  let app, handle;
  const plugin = {
    id: "verification.closing-state", version: "1.0.0", requires: [{ service: applicationServices.application }],
    async setup(context) {
      handle = await open(new URL("../../../../README.md", import.meta.url), "r");
      context.defer(() => handle.close());
      context.on(applicationHooks.created, () => { app = context.get(applicationServices.application).get(); });
      context.on(applicationHooks.beforeClose, async () => {
        assert.ok((await handle.stat()).size > 0);
        await app.recordState("verification.final", { bytes: (await handle.stat()).size });
      });
    },
  };
  app = await AgentApplication.open({ model: await createModel(), store, plugins: [plugin] });
  await app.close();
  const saved = (await store.read(app.sessionId)).find(event => event.type === "state.updated" && event.key === "verification.final");
  assert.ok(saved.value.bytes > 0);
  assert.equal(handle.fd, -1);
  assert.throws(() => app.recordState("verification.after-close", {}), /closed/);
});

test("actual Model metadata controls trace labels across plugin replacement", { timeout: 120_000 }, async t => {
  const selection = selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" });
  const model = createBuiltinProviderModel(selection);
  const processor = new InMemorySpanProcessor();
  const info = { provider: selection.provider, model: selection.model };
  const fullInfo = { ...info, adapter: selection.adapter, profile: selection.profile };
  const app = await AgentApplication.open({
    plugins: [createModelPlugin({ create: () => model, info: fullInfo })],
    store: new InMemorySessionStore(), tracer: new BasicTracer({ processor }),
    traceAttributes: { "may.model.provider": "obsolete", "may.model.name": "obsolete", "may.model.adapter": "obsolete", "may.model.profile": "obsolete", "verification.application": "preserved" },
  });
  t.after(() => app.close());
  await (await app.submit({ input: "Reply with exactly MODEL_INFO_READY." })).result;
  await app.updatePlugins([createModelPlugin({ create: () => model, info })]);
  await (await app.submit({ input: "Reply with exactly MODEL_INFO_UPDATED." })).result;
  await app.updatePlugins([createModelPlugin({ create: () => model })]);
  await (await app.submit({ input: "Reply with exactly MODEL_INFO_UNKNOWN." })).result;
  const runs = processor.getFinishedSpans().filter(span => span.name === "may.run");
  assert.equal(runs.length, 3);
  assert.equal(runs[0].attributes["may.model.adapter"], fullInfo.adapter);
  assert.equal(runs[0].attributes["may.model.profile"], fullInfo.profile);
  assert.equal(runs[1].attributes["may.model.provider"], info.provider);
  assert.equal(runs[1].attributes["may.model.name"], info.model);
  assert.equal(runs[1].attributes["may.model.adapter"], undefined);
  assert.equal(runs[1].attributes["may.model.profile"], undefined);
  for (const key of ["may.model.provider", "may.model.name", "may.model.adapter", "may.model.profile"]) assert.equal(runs[2].attributes[key], undefined);
  assert.ok(runs.every(run => run.attributes["verification.application"] === "preserved"));
  await app.close();
});
