import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineService, PluginHost } from "@may/plugin";
import { compileModelSchema, defineHook, priceUsage } from "@may/core";
import { alwaysOffSampler, BasicTracer, BoundedMetrics, DiagnosticsStore, InMemorySpanProcessor, createOtlpTelemetry } from "@may/observability";
import { services } from "@may/plugin-services";
import { createRuntimePlugin, createContextPlugin } from "@may/plugin-runtime";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { createGatewayRpcAdapter } from "@may/plugin-agent-adapters";

const service = defineService({ id: "consumer.counter", version: "1.0.0", scope: "application" });
const hook = defineHook({
  name: "consumer.increment",
  kind: "transform",
  validate(value) {
    assert.equal(typeof value, "number");
    return value;
  },
});
const host = await PluginHost.create({ hooks: [hook], plugins: [
  {
    id: "counter", version: "1.0.0", provides: [service],
    setup(ctx) { ctx.provide(service, { value: 2 }); },
  },
  {
    id: "add", version: "1.0.0", requires: [{ service }],
    setup(ctx) { ctx.on(hook, (value) => value + ctx.get(service).value); },
  },
] });
const application = await host.createScope("application", { id: "external" });
assert.equal(await application.transform(hook, 5, { signal: new AbortController().signal }), 7);
await host.close();
for (const name of ["models", "skills", "goals", "history-memory", "delegation", "mcp", "observability", "delivery", "channel-telegram", "channel-feishu", "agent-adapters", "coordination", "web-api"]) {
  const module = await import(`@may/plugin-${name}`);
  assert.ok(Object.keys(module).length > 0, `${name} exports its plugin API`);
}
const foundations = await PluginHost.create({ plugins: [createRuntimePlugin(), createContextPlugin(), createPermissionPlugin({ create: () => () => "allow" })] });
const scope = await foundations.createScope("application", { id: "packaged-foundations" });
assert.equal(typeof scope.get(services.runtimeFactory), "function");
assert.equal(typeof scope.get(services.contextFactory).create, "function");
assert.equal(typeof scope.get(services.permissionPolicy), "function");
await foundations.close();
const directory = fileURLToPath(new URL("./rpc-files/", import.meta.url));
await mkdir(directory, { recursive: true });
const text = "Independent plugin installation";
await writeFile(join(directory, "document.txt"), text);
const rpcOptions = { transport: "stdio", command: process.execPath, args: [
  fileURLToPath(import.meta.resolve("@may/plugin-agent-adapters/examples/rpc-file-agent")),
  "--directory", join(directory, "state"), "--workspace", directory,
] };
let adapter = await createGatewayRpcAdapter("files", rpcOptions);
let conversation;
try {
  conversation = await adapter.createConversation("packaged-document");
  const result = await adapter.execute({ conversationId: conversation, inputId: "document-hash",
    input: { role: "user", content: [{ type: "text", text: JSON.stringify({ operation: "sha256", path: "document.txt" }) }] },
    signal: new AbortController().signal, tools: [], shouldYield: () => false,
    report(event) { throw new Error(`Unexpected file Agent event: ${event.type}`); },
  });
  assert.equal(result.text, createHash("sha256").update(text).digest("hex"));
} finally { await adapter.close(); }
adapter = await createGatewayRpcAdapter("files", rpcOptions);
try { assert.equal((await adapter.inspect(conversation, "document-hash")).status, "completed"); }
finally { await adapter.close(); }

const validate = compileModelSchema({
  type: "object", properties: { completed: { type: "boolean" } }, required: ["completed"], additionalProperties: false,
});
assert.equal(validate({ completed: true }), true);
assert.equal(validate({ completed: "invalid" }), false);
const cost = priceUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, completeness: { status: "complete" } }, {
  id: "consumer-prices", version: "1", currency: "USD", source: "consumer",
  effectiveAt: "2026-10-05T00:00:00.000Z", inputPerMillion: 2, outputPerMillion: 4,
});
assert.equal(cost.complete, true);
assert.equal(cost.amount, 0.00004);
assert.equal(cost.pricingVersion, "1");
const metrics = new BoundedMetrics();
const diagnostics = new DiagnosticsStore();
const processor = new InMemorySpanProcessor();
const tracer = new BasicTracer({ processor, metrics, observer: diagnostics, sampler: alwaysOffSampler });
const runSpan = tracer.startSpan("may.run", { attributes: { "may.run.id": "consumer-run", "may.task.id": "consumer-task" } });
const modelSpan = tracer.startSpan("may.model.call", { parent: runSpan.context });
modelSpan.end({ attributes: { "may.model.first_text_ms": 2, "may.model.cost": cost.amount, "may.model.currency": cost.currency } });
runSpan.end();
assert.equal(processor.getFinishedSpans().length, 0);
assert.equal(diagnostics.getDiagnostics({ taskId: "consumer-task" }).spans.length, 2);
assert.equal(metrics.getMetrics().find(metric => metric.name === "may.run.active").value, 0);
assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.call.count").value, 1);

const otlpRequests = [];
const collector = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  otlpRequests.push({ path: request.url, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
const endpoint = `http://127.0.0.1:${collector.address().port}`;
const telemetry = createOtlpTelemetry({ serviceName: "packed-consumer", tracesUrl: `${endpoint}/v1/traces`, metricsUrl: `${endpoint}/v1/metrics` });
try {
  telemetry.tracer.startSpan("may.run").end();
  await telemetry.forceFlush();
  assert.ok(otlpRequests.some(request => request.path === "/v1/traces" && request.data.resourceSpans.length > 0));
  assert.ok(otlpRequests.some(request => request.path === "/v1/metrics" && request.data.resourceMetrics.length > 0));
} finally {
  await telemetry.shutdown();
  await new Promise(resolve => collector.close(resolve));
}
assert.equal(telemetry.getDiagnostics().closed, true);
console.log("Packed plugin and complete runtime dependencies imported and executed successfully");
