import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { createModelPlugin } from "@may/plugin-models";
import { createObservabilityPlugin } from "@may/plugin-observability";
import { openConfiguredMaybeCode } from "../../dist/index.js";

async function workspaceFor(t) {
  const base = fileURLToPath(new URL("../../../../plugin-verification/", import.meta.url));
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "configured-model-plugin-"));
  t.after(async () => {
    assert.ok(resolve(workspace).startsWith(resolve(base) + sep));
    await rm(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function selectionFor() {
  const selection = selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" });
  return {
    ...selection,
    limits: { contextWindowTokens: 65536, maxOutputTokens: 4096 },
    options: { ...selection.options, maxTokens: 4096 },
  };
}

test("a real Model plugin starts, runs and restores a Session with no configured profiles or metadata", { timeout: 120000 }, async t => {
  const workspace = await workspaceFor(t);
  const configPath = join(workspace, "config.json");
  await writeFile(configPath, JSON.stringify({ providers: {}, models: {} }));
  const selection = await selectionFor();
  let creations = 0;
  let model;
  const plugin = createModelPlugin({ create() { creations += 1; model = createBuiltinProviderModel(selection); return model; } });
  const options = { workspace, configPath, dataDirectory: join(workspace, "data"), plugins: [plugin], skills: false, goals: false, subagents: false, instructions: "Answer the user with the exact text requested. Do not call tools." };
  const application = await openConfiguredMaybeCode(options);
  t.after(() => application.close());
  assert.equal(application.modelInfo, undefined);
  assert.deepEqual(await application.listModels(), []);
  assert.equal((await application.getReasoningEffort()).status, "unknown");
  await assert.rejects(application.switchModel("missing"), /Unknown model profile/u);
  await assert.rejects(application.setReasoningEffort("high"), /no configurable profile/u);
  assert.equal((await application.inspectContext()).contextWindowTokens, model.limits?.contextWindowTokens);
  assert.equal(model.limits.contextWindowTokens, 65536);
  const result = await (await application.submit({ input: "Reply with exactly CONFIGURED_PLUGIN_OK." })).result;
  assert.match(JSON.stringify(result.message), /CONFIGURED_PLUGIN_OK/u);
  const sessionId = application.sessionId;
  await application.close();
  const resumed = await openConfiguredMaybeCode({ ...options, sessionId });
  t.after(() => resumed.close());
  assert.equal(resumed.sessionId, sessionId);
  assert.equal(resumed.modelInfo, undefined);
  assert.equal(creations, 2);
  assert.equal((await resumed.inspectContext()).contextWindowTokens, model.limits?.contextWindowTokens);
  const continued = await (await resumed.submit({ input: "Reply with exactly PLUGIN_RESUMED if the previous request asked for CONFIGURED_PLUGIN_OK." })).result;
  assert.match(JSON.stringify(continued.message), /PLUGIN_RESUMED/u);
  await resumed.close();
});

test("selected real Model metadata and Context limits replace unused configured profiles and trace labels", { timeout: 120000 }, async t => {
  const workspace = await workspaceFor(t);
  const configPath = join(workspace, "config.json");
  await writeFile(configPath, JSON.stringify({
    providers: { unused: { adapter: "unregistered-review-adapter" } },
    models: { unused: { provider: "unused", model: "unused", contextWindowTokens: 1000 } },
    defaultModel: "unused",
  }));
  const selection = await selectionFor();
  const info = { provider: selection.provider, adapter: selection.adapter, model: selection.model };
  let model;
  const application = await openConfiguredMaybeCode({
    workspace, configPath, dataDirectory: join(workspace, "data"),
    plugins: [
      createModelPlugin({ info, create() { model = createBuiltinProviderModel(selection); return model; } }),
      createObservabilityPlugin({ dataDirectory: workspace, scheduledDelayMs: 60000 }),
    ],
    skills: false, goals: false, subagents: false,
    instructions: "Answer with the exact text requested. Do not call tools.",
  });
  t.after(() => application.close());
  assert.deepEqual(application.modelInfo, info);
  assert.equal((await application.inspectContext()).contextWindowTokens, model.limits?.contextWindowTokens);
  assert.equal(model.limits.contextWindowTokens, 65536);
  const result = await (await application.submit({ input: "Reply with exactly METADATA_VERIFIED." })).result;
  assert.match(JSON.stringify(result.message), /METADATA_VERIFIED/u);
  await application.close();
  const directory = join(workspace, "traces");
  const spans = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), "utf8"))))
    .join("\n").trim().split(/\n+/u).map(value => JSON.parse(value));
  const run = spans.find(span => span.name === "may.run");
  assert.ok(run);
  assert.equal(run.attributes["may.model.provider"], info.provider);
  assert.equal(run.attributes["may.model.name"], info.model);
  assert.equal(run.attributes["may.model.adapter"], info.adapter);
  assert.equal(run.attributes["may.model.profile"], undefined);
  assert.ok(!JSON.stringify(spans).includes("unregistered-review-adapter"));
});

test("an explicit Context budget takes priority over the selected real Model limits", async t => {
  const workspace = await workspaceFor(t);
  const configPath = join(workspace, "config.json");
  await writeFile(configPath, JSON.stringify({ providers: {}, models: {} }));
  const selection = await selectionFor();
  const application = await openConfiguredMaybeCode({
    workspace, configPath, dataDirectory: join(workspace, "data"),
    plugins: [createModelPlugin({ create: () => createBuiltinProviderModel(selection) })],
    contextBudget: { contextWindowTokens: 32768, outputReserveTokens: 1024 },
    skills: false, goals: false, subagents: false,
  });
  t.after(() => application.close());
  const inspected = await application.inspectContext();
  assert.equal(inspected.contextWindowTokens, 32768);
  assert.equal(inspected.reservedTokens, 1024);
  await application.close();
});
