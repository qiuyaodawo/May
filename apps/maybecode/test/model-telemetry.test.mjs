import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemorySessionStore } from "@may/session";
import { createObservabilityPlugin } from "@may/plugin-observability";
import { createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "@may/providers";
import { InMemorySessionCatalog, MaybeCodeWorkspace, startMaybeCodeWebUI } from "../dist/index.js";
import { startLocalTelemetryService, localTelemetrySelection } from "../../../packages/providers/test/fixtures/local-telemetry-service.mjs";

const base = fileURLToPath(new URL("../dist/test-output/model-telemetry/", import.meta.url));

test("MaybeCode exposes shared model capabilities and current-session diagnostics over authenticated HTTP", async t => {
  await mkdir(base, { recursive: true });
  const directory = await realpath(await mkdtemp(join(base, "case-")));
  const service = await startLocalTelemetryService(t);
  const resolver = createModelCapabilityResolver();
  const selection = localTelemetrySelection(service.baseURL);
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selection);
  const app = await MaybeCodeWorkspace.open({
    git: false, workspace: directory, model,
    modelInfo: { profile: "local", provider: "local", adapter: selection.adapter, model: selection.model },
    modelProfiles: [{ name: "local", provider: "local", adapter: selection.adapter, model: selection.model, isDefault: true }],
    resolveModelCapabilities: (profile, options) => {
      assert.equal(profile, "local");
      return resolver.resolve(selection, options);
    },
    plugins: [createObservabilityPlugin({ dataDirectory: directory, samplingRatio: 0 })],
    store: new InMemorySessionStore(), catalog: new InMemorySessionCatalog(), autoResume: false,
    tools: [], skills: false, goals: false, subagents: false,
  });
  const token = "telemetry-auth-0123456789abcdef012345";
  const server = await startMaybeCodeWebUI(app, { token, port: 0 });
  t.after(async () => {
    await server.close();
    await app.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await fetch(server.url + "/api/ui/snapshot")).status, 401);
  const snapshot = async () => {
    const response = await fetch(server.url + "/api/ui/snapshot", { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await snapshot();
  assert.ok(initial.commands.includes("model.capabilities.refresh"));
  assert.ok(initial.panels.find(panel => panel.id === "model-capabilities").fields.some(field => field.label === "能力版本"));
  assert.equal(service.state.catalogs, 1);
  const result = await (await app.submit({ input: "private first session input" })).result;
  assert.equal(result.message.content.find(part => part.type === "text").text, "answer-1");
  assert.equal(service.state.catalogs, 1);
  const firstSession = app.sessionId;
  const first = app.getTelemetry();
  assert.ok(first.spans.some(span => span.name === "may.model.call"));
  assert.ok(first.spans.every(span => span.attributes["may.session.id"] === firstSession));
  assert.ok(first.spans.every(span => !span.sampled));
  const call = first.spans.find(span => span.name === "may.model.call");
  assert.equal(call.attributes["may.model.capability_version"], (await resolver.resolve(selection)).version);
  assert.ok(call.attributes["may.model.first_content_ms"] <= call.attributes["may.model.first_text_ms"]);
  const afterRun = await snapshot();
  const panelText = JSON.stringify(afterRun.panels.find(panel => panel.id === "telemetry"));
  assert.match(panelText, /may.model.call/);
  assert.ok(panelText.includes(call.context.spanId));
  assert.ok(!panelText.includes("private first session input"));
  assert.ok(!panelText.includes("internal diagnostic service reasoning"));
  assert.ok(!JSON.stringify(afterRun.panels).includes("local-service-credential"));

  service.state.efforts = ["medium", "high"];
  const refreshed = await fetch(server.url + "/api/ui/commands", {
    method: "POST", headers,
    body: JSON.stringify({ version: 1, hostId: afterRun.hostId, requestId: "refresh-local", name: "model.capabilities.refresh", targetId: afterRun.selectedId, expectedActiveId: afterRun.activeId, args: {} }),
  });
  assert.equal(refreshed.status, 200, await refreshed.text());
  assert.equal(service.state.catalogs, 2);
  assert.deepEqual((await app.getModelCapabilities()).reasoningEffort.efforts, ["medium", "high"]);
  assert.notEqual((await app.getModelCapabilities()).version, call.attributes["may.model.capability_version"]);
  await app.newSession();
  assert.notEqual(app.sessionId, firstSession);
  assert.ok(app.getTelemetry().spans.every(span => span.attributes["may.session.id"] === app.sessionId));
  assert.ok(app.getTelemetry().spans.every(span => !["may.run", "may.model.call"].includes(span.name)));
  assert.throws(() => app.getTelemetry({ sessionId: firstSession }), /does not belong/);
  await (await app.submit({ input: "private second session input" })).result;
  const second = app.getTelemetry();
  assert.ok(second.spans.length > 0);
  assert.ok(second.spans.every(span => span.attributes["may.session.id"] === app.sessionId));
  assert.ok(second.spans.every(span => !first.spans.some(previous => previous.context.spanId === span.context.spanId)));
  const secondPanel = JSON.stringify((await snapshot()).panels.find(panel => panel.id === "telemetry"));
  assert.ok(!secondPanel.includes(call.context.spanId));
});
