import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseMayConfig } from "@may/config";
import { AgentGateway, GatewayUiHost, gatewaySettings, loadGatewayAdapter } from "../dist/index.js";
import { startLocalTelemetryService, localTelemetrySelection } from "../../../packages/providers/test/fixtures/local-telemetry-service.mjs";

const base = fileURLToPath(new URL("../dist/test-output/model-telemetry/", import.meta.url));
const operator = { kind: "operator", id: "control" };

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const service = await startLocalTelemetryService(t);
  const selected = localTelemetrySelection(service.baseURL);
  const agent = { id: "local", adapter: "may", model: "local", plugins: [{
    module: new URL("./fixtures/telemetry-plugin.mjs", import.meta.url).href,
    config: { dataDirectory: directory, samplingRatio: 0 },
  }] };
  const configuration = { providers: { local: selected.providerConfig }, models: { local: { provider: "local", model: selected.model, capabilities: selected.capabilities } }, defaultModel: "local", apps: { maybeclaw: { version: 2, agents: [agent] } } };
  const configPath = join(directory, "may.config.json");
  await writeFile(configPath, JSON.stringify(configuration));
  const gateway = new AgentGateway({ directory, configPath, settings: gatewaySettings(parseMayConfig(configuration, configPath)) });
  const ui = new GatewayUiHost(gateway);
  t.after(async () => {
    ui.close();
    await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, service, agent, configPath, gateway, ui };
}

async function complete(gateway, taskId) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = gateway.store.get("tasks", taskId);
    if (["completed", "failed", "cancelled"].includes(task?.status)) {
      assert.equal(task.status, "completed", JSON.stringify(task));
      return task;
    }
    await delay(10);
  }
  throw new Error(`Gateway task ${taskId} did not complete`);
}

test("configured May Gateway adapter shares discovery with execution and restricts diagnostics to its conversation", async t => {
  const { directory, configPath, agent, service } = await fixture(t);
  const adapter = await loadGatewayAdapter({ directory, configPath, agent });
  t.after(() => adapter.close());
  const capabilities = await adapter.modelCapabilities();
  assert.equal(service.state.catalogs, 1);
  const first = await adapter.createConversation("direct-first");
  const result = await adapter.execute({ conversationId: first, inputId: "input-first", input: "private adapter input", signal: new AbortController().signal, tools: [], shouldYield: () => false, report: () => {} });
  assert.equal(result.text, "answer-1");
  assert.equal(service.state.catalogs, 1);
  const diagnostic = adapter.diagnostics(first);
  assert.ok(diagnostic.spans.every(span => span.attributes["may.session.id"] === first));
  assert.equal(diagnostic.spans.find(span => span.name === "may.model.call").attributes["may.model.capability_version"], capabilities.version);
  const second = await adapter.createConversation("direct-second");
  assert.ok(adapter.diagnostics(second).spans.every(span => span.attributes["may.session.id"] === second));
  assert.ok(adapter.diagnostics(second).spans.every(span => !["may.run", "may.model.call"].includes(span.name)));
  assert.equal(adapter.diagnostics("foreign-conversation"), undefined);
  service.state.efforts = ["medium", "high"];
  assert.deepEqual((await adapter.modelCapabilities(true)).reasoningEffort.efforts, ["medium", "high"]);
  assert.equal(service.state.catalogs, 2);
});

test("Gateway UI agent.check refreshes capabilities and session.diagnostics retains selected-session scope", async t => {
  const { gateway, ui, service } = await fixture(t);
  const command = (name, targetId, args = {}) => ({ version: 1, hostId: ui.hostId, requestId: `${name}-${targetId ?? "global"}-${service.state.catalogs}`, name, targetId, args });
  const checked = await ui.execute(command("agent.check", null, { id: "local" }));
  assert.deepEqual(JSON.parse(checked.output.text).model.reasoningEffort.efforts, ["low", "high"]);
  assert.equal(service.state.catalogs, 1);
  assert.ok(checked.output.actions.some(action => action.command === "agent.check" && action.args.refresh === "true"));
  const first = gateway.createSession(operator, "first telemetry session", ["local"]);
  const firstReceipt = await gateway.handle("private gateway first input", operator, { requestId: "first-input", sessionId: first.id });
  await complete(gateway, firstReceipt.taskIds[0]);
  assert.equal(service.state.catalogs, 1);
  const firstBinding = gateway.store.get("bindings", `${first.id}:local`);
  const adapter = await gateway.adapter("local");
  const firstSpans = adapter.diagnostics(firstBinding.conversationId).spans;
  const firstCall = firstSpans.find(span => span.name === "may.model.call");
  assert.ok(firstCall);
  assert.ok(firstSpans.every(span => span.attributes["may.session.id"] === firstBinding.conversationId));
  assert.ok(firstSpans.every(span => !span.sampled));
  const firstDiagnostics = await ui.execute(command("session.diagnostics", first.id));
  assert.ok(firstDiagnostics.output.text.includes(firstCall.context.spanId));
  assert.ok(!firstDiagnostics.output.text.includes("private gateway first input"));
  assert.ok(!firstDiagnostics.output.text.includes("internal diagnostic service reasoning"));
  assert.ok(!firstDiagnostics.output.text.includes("local-service-credential"));
  const second = gateway.createSession(operator, "second telemetry session", ["local"]);
  const empty = await ui.execute(command("session.diagnostics", second.id));
  assert.match(empty.output.text, /尚无 Agent 对话/);
  const secondReceipt = await gateway.handle("private gateway second input", operator, { requestId: "second-input", sessionId: second.id });
  await complete(gateway, secondReceipt.taskIds[0]);
  const secondBinding = gateway.store.get("bindings", `${second.id}:local`);
  const secondCall = adapter.diagnostics(secondBinding.conversationId).spans.find(span => span.name === "may.model.call");
  const secondDiagnostics = await ui.execute(command("session.diagnostics", second.id));
  assert.ok(secondDiagnostics.output.text.includes(secondCall.context.spanId));
  assert.ok(!secondDiagnostics.output.text.includes(firstCall.context.spanId));
  await assert.rejects(ui.execute(command("session.diagnostics", second.id, { sessionId: first.id })), /参数|Unknown|unexpected|Unexpected/);
  service.state.efforts = ["medium", "high"];
  const refreshed = await ui.execute(command("agent.check", null, { id: "local", refresh: "true" }));
  assert.deepEqual(JSON.parse(refreshed.output.text).model.reasoningEffort.efforts, ["medium", "high"]);
  assert.equal(service.state.catalogs, 2);
  assert.ok((await ui.snapshot(second.id)).commands.includes("session.diagnostics"));
});
