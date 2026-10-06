import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAgent } from "../packages/application/dist/index.js";
import { loadMayConfig } from "../packages/config/dist/index.js";
import { createBuiltinProviderAdapterRegistry, createModelCapabilityResolver, selectProviderModel } from "../packages/providers/dist/index.js";
import { BasicTracer, BoundedMetrics, DiagnosticsStore } from "../packages/observability/dist/index.js";
import { FileSessionStore } from "../packages/session/dist/file-store.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = join(repository, "review", "model-telemetry-live");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const selection = selectProviderModel(await loadMayConfig());
const resolver = createModelCapabilityResolver();
const capabilities = await resolver.resolve(selection);
const registry = createBuiltinProviderAdapterRegistry({ resolver });
const diagnostics = new DiagnosticsStore();
const metrics = new BoundedMetrics();
const tracer = new BasicTracer({ processor: diagnostics, observer: diagnostics, metrics });
const responseFormat = ["openai-responses", "openai-chat-completions"].includes(selection.adapter)
  ? { type: "jsonSchema", name: "verification", strict: true, schema: { type: "object", properties: { result: { type: "string", enum: ["ok"] } }, required: ["result"], additionalProperties: false } }
  : undefined;
const definition = defineAgent({
  model: registry.create(selection), tracer, permissionPolicy: () => "deny",
  ...(responseFormat === undefined ? {} : { responseFormat }),
  runBudget: { maxDurationMs: 120_000, maxModelCalls: 1, maxSteps: 1 },
  traceAttributes: { "may.configuration.version": "model-telemetry-verification-1" },
});
const application = await definition.open({ store: new FileSessionStore(join(directory, "sessions")) });
try {
  const startedAt = new Date().toISOString();
  console.log(JSON.stringify({ phase: "model-request", startedAt, profile: selection.profile, model: selection.model, adapter: selection.adapter }));
  const run = await application.submit({ input: responseFormat === undefined ? "请只回复：遥测验证完成。" : '请按照指定 JSON Schema 回复 {"result":"ok"}。' });
  const result = await run.result;
  assert.equal(result.modelCalls, 1);
  assert.ok(result.usage && result.usage.inputTokens >= 0 && result.usage.outputTokens >= 0);
  const spans = diagnostics.getDiagnostics({ sessionId: application.sessionId }).spans;
  const call = spans.find(span => span.name === "may.model.call");
  const attempt = spans.find(span => span.name === "may.model.attempt");
  assert.equal(call.status, "ok");
  assert.equal(attempt.status, "ok");
  assert.equal(attempt.parentSpanId, call.context.spanId);
  assert.equal(call.attributes["may.model.capability_version"], capabilities.version);
  assert.ok(call.attributes["may.model.first_content_ms"] >= 0);
  assert.ok(metrics.getMetrics().some(metric => metric.name === "may.model.call.count" && metric.value === 1));
  const records = resolver.verificationRecords(selection);
  assert.ok(records.some(record => record.success));
  const report = { startedAt, completedAt: new Date().toISOString(), profile: selection.profile, model: selection.model, adapter: selection.adapter,
    structuredOutput: responseFormat !== undefined, usage: result.usage, capabilityVersion: capabilities.version,
    diagnostics: diagnostics.getDiagnostics({ sessionId: application.sessionId }), metrics: metrics.getMetrics(), records };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: "verified", profile: selection.profile, structuredOutput: responseFormat !== undefined, report: join(directory, "report.json") }));
} finally {
  await application.close();
}
