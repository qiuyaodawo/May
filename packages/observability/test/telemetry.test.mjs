import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { InMemoryContext, May, createModelAttemptObserver, priceUsage } from "@may/core";
import {
  BasicTracer, BoundedMetrics, DiagnosticsStore, InMemorySpanProcessor,
  BatchSpanProcessor, JsonlFileSpanExporter, alwaysOffSampler, createOtlpTelemetry,
} from "../dist/index.js";
import { RetryingModel, createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "../../providers/dist/index.js";
import { OpenAIChatCompletionsModel } from "../../providers/openai-compatible/dist/index.js";
import { localTelemetrySelection, startLocalTelemetryService } from "../../providers/test/fixtures/local-telemetry-service.mjs";

test("metrics and local diagnostics include unsampled operations, active spans, and bounded records", () => {
  const processor = new InMemorySpanProcessor();
  const metrics = new BoundedMetrics({ maxSeries: 16 });
  const observer = new DiagnosticsStore({ maxSpans: 3 });
  const tracer = new BasicTracer({ processor, observer, metrics, sampler: alwaysOffSampler });
  const run = tracer.startSpan("may.run", { attributes: { "may.run.id": "run", "may.task.id": "task", "may.session.id": "session" } });
  const call = tracer.startSpan("may.model.call", { parent: run.context });
  assert.equal(observer.getDiagnostics().spans.filter(span => !span.ended).length, 2);
  call.end({ attributes: { "may.model.attempts": 1, "may.model.first_content_ms": 4, "may.model.has_text": false, "may.model.usage_available": false } });
  run.end();
  assert.equal(processor.getFinishedSpans().length, 0);
  assert.equal(observer.getDiagnostics({ sessionId: "session" }).spans.length, 2);
  assert.ok(observer.getDiagnostics().spans.every(span => span.sampled === false));
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.run.active").value, 0);
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.call.count").value, 1);
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.usage_missing").value, 1);
  observer.recordAssessment({ taskId: "task", evaluator: "files", evaluatorVersion: "1", result: "passed", evidenceReferences: ["artifact:report"] });
  assert.equal(observer.getDiagnostics({ taskId: "task" }).assessments[0].result, "passed");
  assert.throws(() => observer.getDiagnostics({ limit: 501 }), RangeError);
  assert.throws(() => tracer.startSpan("example", { attributes: { prompt: "private" } }), TypeError);
  assert.throws(() => tracer.startSpan("example", { attributes: { value: "x".repeat(257) } }), RangeError);
  const attempt = createModelAttemptObserver({ tracer, modelCallId: "other" }).start(1);
  attempt.content("tool");
  attempt.end({ status: "ok", completed: true });
  const recorded = observer.getDiagnostics().spans.find(span => span.name === "may.model.attempt");
  assert.equal(recorded.attributes["may.model.has_text"], false);
  assert.equal(recorded.attributes["may.model.first_text_ms"], undefined);
  assert.equal(observer.getDiagnostics().spans.length, 3);
  const refreshed = tracer.startSpan("may.model.call");
  refreshed.end({ attributes: { "may.model.provider": "updated" } });
  assert.ok(metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
});

test("actual provider retries have independent attempt spans and first output timings", async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 请求由实际 adapter 发送。 */ }
    requests += 1;
    if (requests === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unavailable", type: "server_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "private reasoning" }, finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 15));
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "private answer" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const processor = new InMemorySpanProcessor();
  const metrics = new BoundedMetrics();
  const tracer = new BasicTracer({ processor, metrics });
  const model = new RetryingModel(new OpenAIChatCompletionsModel({ apiKey: "local-test", model: "local", baseURL: `http://127.0.0.1:${server.address().port}` }), { baseDelayMs: 20, maxDelayMs: 20, jitterRatio: 0 });
  const runtime = new May({ context: new InMemoryContext(), model, tracer });
  await runtime.run({ input: "private prompt" }).result;
  const spans = processor.getFinishedSpans();
  const attempts = spans.filter(span => span.name === "may.model.attempt");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(span => span.status), ["error", "ok"]);
  assert.equal(attempts[0].attributes["may.model.first_content_ms"], undefined);
  assert.ok(attempts[1].attributes["may.model.first_text_ms"] >= attempts[1].attributes["may.model.first_content_ms"]);
  const call = spans.find(span => span.name === "may.model.call");
  assert.ok(call.attributes["may.model.first_text_ms"] >= 20);
  assert.equal(call.attributes["may.model.attempts"], 2);
  assert.ok(attempts.every(span => span.parentSpanId === call.context.spanId));
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.retries").value, 1);
  assert.ok(call.attributes["may.model.retry_wait_ms"] >= 15);
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.retry_wait").sum, call.attributes["may.model.retry_wait_ms"]);
  assert.doesNotMatch(JSON.stringify(spans), /private prompt|private answer|private reasoning|local-test/);
});

test("real provider attempt metrics retain distinct provider and model labels with sampling disabled", async t => {
  const service = await startLocalTelemetryService(t);
  const metrics = new BoundedMetrics();
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), metrics, observer: diagnostics, sampler: alwaysOffSampler });
  const registry = createBuiltinProviderAdapterRegistry({ resolver: createModelCapabilityResolver({ discoveries: [] }) });
  for (const identity of ["one", "two"]) {
    const selection = { ...localTelemetrySelection(service.baseURL), provider: `provider-${identity}`, model: `model-${identity}`, profile: `profile-${identity}` };
    const model = new RetryingModel(registry.create(selection));
    await new May({ context: new InMemoryContext(), model, tracer }).run({ input: "private query" }).result;
  }
  assert.equal(service.state.requests.length, 2);
  const attempts = metrics.getMetrics().filter(metric => metric.name === "may.model.attempt.count");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(metric => metric.attributes["may.model.provider"]).sort(), ["provider-one", "provider-two"]);
  assert.deepEqual(attempts.map(metric => metric.attributes["may.model.name"]).sort(), ["model-one", "model-two"]);
  assert.ok(attempts.every(metric => metric.value === 1 && metric.attributes["may.model.adapter"] === "openai-chat-completions"));
  assert.ok(metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
  assert.ok(diagnostics.getDiagnostics().spans.filter(span => span.name === "may.model.attempt").every(span => typeof span.attributes["may.run.id"] === "string" && span.attributes["may.step"] === 1 && span.sampled === false));
});

test("cancelled retry waits report actual elapsed waiting without a second physical attempt", async t => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 接收实际 adapter 请求。 */ }
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Unavailable", type: "server_error" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const diagnostics = new DiagnosticsStore();
  const metrics = new BoundedMetrics();
  const model = new RetryingModel(new OpenAIChatCompletionsModel({ apiKey: "local-test", model: "local", baseURL: `http://127.0.0.1:${server.address().port}` }), { baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 });
  const run = new May({ context: new InMemoryContext(), model, tracer: new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics, metrics, sampler: alwaysOffSampler }) }).run({ input: "query" });
  const rejected = assert.rejects(run.result);
  for await (const event of run.events) if (event.type === "model.retrying") {
    await delay(20);
    run.cancel();
    break;
  }
  await rejected;
  assert.equal(requests, 1);
  const call = diagnostics.getDiagnostics().spans.find(span => span.name === "may.model.call");
  assert.equal(call.status, "cancelled");
  assert.equal(call.attributes["may.model.attempts"], 1);
  assert.ok(call.attributes["may.model.retry_wait_ms"] >= 10);
  assert.ok(call.attributes["may.model.retry_wait_ms"] < 1_000);
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.model.retry_wait").sum, call.attributes["may.model.retry_wait_ms"]);
  assert.ok(metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
});

test("assessment scope remains explicit or uniquely inferred across repeated task names and retained-span eviction", () => {
  const diagnostics = new DiagnosticsStore({ maxSpans: 2 });
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics });
  const operation = (taskId, sessionId, coordinationId, runId) => {
    const span = tracer.startSpan("may.run", { attributes: { "may.task.id": taskId, "may.session.id": sessionId, "may.coordination.id": coordinationId, "may.run.id": runId } });
    span.end({ status: "ok" });
    return span;
  };
  const first = operation("shared", "session-one", "coordination-one", "run-one");
  diagnostics.recordAssessment({ taskId: "shared", evaluator: "first", evaluatorVersion: "1", result: "passed" });
  operation("shared", "session-two", "coordination-two", "run-two");
  diagnostics.recordAssessment({ taskId: "shared", evaluator: "ambiguous", evaluatorVersion: "1", result: "inconclusive" });
  diagnostics.recordAssessment({ taskId: "shared", sessionId: "session-two", evaluator: "second", evaluatorVersion: "1", result: "failed" });
  const scoped = (query) => diagnostics.getDiagnostics(query).assessments.map(value => value.evaluator);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-one" }), ["first"]);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-two" }), ["second"]);
  assert.deepEqual(scoped({ coordinationId: "coordination-one" }), ["first"]);
  assert.deepEqual(scoped({ traceId: first.context.traceId }), ["first"]);
  assert.deepEqual(scoped({ sessionId: "session-one", runId: "run-two" }), []);
  assert.deepEqual(scoped({ taskId: "shared" }), ["first", "ambiguous", "second"]);
  operation("different", "session-two", "coordination-two", "run-three");
  diagnostics.recordAssessment({ taskId: "different", evaluator: "different", evaluatorVersion: "1", result: "passed" });
  assert.deepEqual(scoped({ taskId: "different", sessionId: "session-one" }), []);
  operation("other", "session-three", "coordination-three", "run-four");
  assert.equal(diagnostics.getDiagnostics({ taskId: "shared" }).spans.length, 0);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-one" }), ["first"]);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-two" }), ["second"]);
  assert.deepEqual(scoped({ taskId: "shared", coordinationId: "coordination-two", runId: "run-two" }), ["second"]);
  assert.deepEqual(scoped({ taskId: "shared" }), ["first", "ambiguous", "second"]);
  assert.throws(() => diagnostics.recordAssessment({ taskId: "shared", sessionId: "x".repeat(257), evaluator: "limits", evaluatorVersion: "1", result: "passed" }), RangeError);
});

test("cost metrics distinguish provider charges, complete estimates and partial estimates in one currency", () => {
  const metrics = new BoundedMetrics();
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), metrics });
  const prices = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  const costs = [
    priceUsage({ inputTokens: 2, outputTokens: 3, totalTokens: 5, completeness: { status: "complete" } }, prices),
    priceUsage({ inputTokens: 2, outputTokens: 3, totalTokens: 5, completeness: { status: "partial" } }, prices),
    priceUsage({ reportedCost: { amount: 0.25, currency: "USD", source: "local-billing" } }),
  ];
  for (const cost of costs) tracer.startSpan("may.model.call").end({ attributes: {
    "may.model.cost": cost.amount, "may.model.currency": cost.currency,
    "may.model.cost_kind": cost.kind, "may.model.cost_complete": cost.complete,
  } });
  const values = metrics.getMetrics().filter(metric => metric.name === "may.model.cost");
  assert.equal(values.length, 3);
  for (const cost of costs) {
    const value = values.find(metric => metric.attributes.cost_kind === cost.kind && metric.attributes.cost_complete === cost.complete);
    assert.equal(value.value, cost.amount);
    assert.equal(value.attributes.currency, "USD");
  }
});

test("OTLP uses the official HTTP exporters for actual trace and metric requests", async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const observer = new DiagnosticsStore();
  const telemetry = createOtlpTelemetry({ serviceName: "local-test", tracesUrl: `${endpoint}/v1/traces`, metricsUrl: `${endpoint}/v1/metrics`, observer });
  t.after(() => telemetry.shutdown());
  const run = telemetry.tracer.startSpan("may.run");
  const child = telemetry.tracer.startSpan("may.model.call", { parent: run.context });
  child.end();
  run.end();
  await telemetry.forceFlush();
  const traceData = received.find(value => value.path === "/v1/traces").data;
  const spans = traceData.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  assert.equal(spans.length, 2);
  assert.equal(spans.find(span => span.name === "may.model.call").parentSpanId, run.context.spanId);
  assert.ok(received.some(value => value.path === "/v1/metrics"));
  assert.equal(observer.getDiagnostics().spans.length, 2);
  await telemetry.shutdown();
});

test("real file export failures produce bounded diagnostics and metrics", async (t) => {
  const output = join(process.cwd(), "dist", "test-output");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "telemetry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new BoundedMetrics();
  const processor = new BatchSpanProcessor(new JsonlFileSpanExporter({ path: directory }), { maxQueueSize: 2, maxExportBatchSize: 1, metrics });
  const tracer = new BasicTracer({ processor });
  tracer.startSpan("may.run").end();
  await processor.shutdown();
  assert.equal(processor.getDiagnostics().exportFailures, 1);
  assert.equal(processor.getDiagnostics().queueSize, 0);
  assert.equal(metrics.getMetrics().find(metric => metric.name === "may.telemetry.export_failures").value, 1);
});

test("OTLP exporter failure and timeout are observable and bounded", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 接收真实 OTLP 请求。 */ }
    if (request.url.startsWith("/timeout")) {
      const timer = setTimeout(() => response.end("{}"), 300);
      response.on("close", () => clearTimeout(timer));
    } else {
      response.writeHead(400);
      response.end("Invalid export");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createOtlpTelemetry({ serviceName: "failed-export", tracesUrl: `${endpoint}/v1/traces`, metricsUrl: `${endpoint}/v1/metrics`, timeoutMs: 100 });
  telemetry.tracer.startSpan("may.run").end();
  await telemetry.forceFlush();
  assert.ok(telemetry.getDiagnostics().traceExportFailures >= 1);
  assert.ok(telemetry.getDiagnostics().metricExportFailures >= 1);
  await telemetry.shutdown();
  assert.equal(telemetry.getDiagnostics().closed, true);
  const timeout = createOtlpTelemetry({ serviceName: "timeout-export", tracesUrl: `${endpoint}/timeout/traces`, metricsUrl: `${endpoint}/timeout/metrics`, timeoutMs: 40 });
  timeout.tracer.startSpan("may.run").end();
  const started = performance.now();
  await timeout.forceFlush();
  assert.ok(performance.now() - started < 1_000);
  assert.ok(timeout.getDiagnostics().traceExportFailures >= 1);
  await timeout.shutdown();
});

test("actual tool-only response records first content with absent first text", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 接收真实模型请求。 */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-local", type: "function", function: { name: "inspect", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const processor = new InMemorySpanProcessor();
  const model = new RetryingModel(new OpenAIChatCompletionsModel({ apiKey: "local-test", model: "local", baseURL: `http://127.0.0.1:${server.address().port}` }));
  const observer = createModelAttemptObserver({ tracer: new BasicTracer({ processor }), modelCallId: "tool-only" });
  for await (const _event of model.stream({ messages: [], tools: [] }, { signal: new AbortController().signal, attemptObserver: observer })) { /* 消费实际 adapter stream。 */ }
  const attempt = processor.getFinishedSpans()[0];
  assert.equal(attempt.status, "ok");
  assert.equal(attempt.attributes["may.model.has_content"], true);
  assert.equal(attempt.attributes["may.model.has_text"], false);
  assert.equal(typeof attempt.attributes["may.model.first_content_ms"], "number");
  assert.equal(attempt.attributes["may.model.first_text_ms"], undefined);
});

test("actual provider cancellation and incomplete response retain attempt outcomes", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 接收真实模型请求。 */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (request.url === "/incomplete/chat/completions") { response.end("data: [DONE]\n\n"); return; }
    const timer = setTimeout(() => response.end(), 200);
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const mode of ["incomplete", "cancel"]) {
    const processor = new InMemorySpanProcessor();
    const model = new RetryingModel(new OpenAIChatCompletionsModel({ apiKey: "local-test", model: "local", baseURL: `http://127.0.0.1:${server.address().port}/${mode}` }));
    const runtime = new May({ context: new InMemoryContext(), model, tracer: new BasicTracer({ processor }) });
    const run = runtime.run({ input: "query" });
    const timer = mode === "cancel" ? setTimeout(() => run.cancel(), 25) : undefined;
    try { await assert.rejects(run.result); } finally { if (timer !== undefined) clearTimeout(timer); }
    const attempt = processor.getFinishedSpans().find(span => span.name === "may.model.attempt");
    assert.equal(attempt.status, mode === "cancel" ? "cancelled" : "error");
    assert.equal(attempt.attributes["may.model.has_content"], false);
    assert.equal(attempt.attributes["may.model.first_content_ms"], undefined);
    assert.equal(attempt.attributes["may.model.usage_available"], false);
  }
});
