import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  BasicTracer,
  BoundedMetrics,
  DiagnosticsStore,
  BatchSpanProcessor,
  JsonlFileSpanExporter,
  createOtlpTelemetry,
} from "../dist/index.js";

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
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const observer = new DiagnosticsStore();
  const telemetry = createOtlpTelemetry({
    serviceName: "local-test",
    tracesUrl: `${endpoint}/v1/traces`,
    metricsUrl: `${endpoint}/v1/metrics`,
    observer,
  });
  t.after(() => telemetry.shutdown());
  const run = telemetry.tracer.startSpan("may.run");
  const child = telemetry.tracer.startSpan("may.model.call", { parent: run.context });
  child.end();
  run.end();
  await telemetry.forceFlush();
  const traceData = received.find((value) => value.path === "/v1/traces").data;
  const spans = traceData.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
  assert.equal(spans.length, 2);
  assert.equal(spans.find((span) => span.name === "may.model.call").parentSpanId, run.context.spanId);
  assert.ok(received.some((value) => value.path === "/v1/metrics"));
  assert.equal(observer.getDiagnostics().spans.length, 2);
  await telemetry.shutdown();
});

test("real file export failures produce bounded diagnostics and metrics", async (t) => {
  const output = join(process.cwd(), "dist", "test-output");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "telemetry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = new BoundedMetrics();
  const processor = new BatchSpanProcessor(new JsonlFileSpanExporter({ path: directory }), {
    maxQueueSize: 2,
    maxExportBatchSize: 1,
    metrics,
  });
  const tracer = new BasicTracer({ processor });
  tracer.startSpan("may.run").end();
  await processor.shutdown();
  assert.equal(processor.getDiagnostics().exportFailures, 1);
  assert.equal(processor.getDiagnostics().queueSize, 0);
  assert.equal(metrics.getMetrics().find((metric) => metric.name === "may.telemetry.export_failures").value, 1);
});

test("OTLP exporter failure and timeout are observable and bounded", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收真实 OTLP 请求。 */
    }
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
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createOtlpTelemetry({
    serviceName: "failed-export",
    tracesUrl: `${endpoint}/v1/traces`,
    metricsUrl: `${endpoint}/v1/metrics`,
    timeoutMs: 100,
  });
  telemetry.tracer.startSpan("may.run").end();
  await telemetry.forceFlush();
  assert.ok(telemetry.getDiagnostics().traceExportFailures >= 1);
  assert.ok(telemetry.getDiagnostics().metricExportFailures >= 1);
  await telemetry.shutdown();
  assert.equal(telemetry.getDiagnostics().closed, true);
  const timeout = createOtlpTelemetry({
    serviceName: "timeout-export",
    tracesUrl: `${endpoint}/timeout/traces`,
    metricsUrl: `${endpoint}/timeout/metrics`,
    timeoutMs: 40,
  });
  timeout.tracer.startSpan("may.run").end();
  const started = performance.now();
  await timeout.forceFlush();
  assert.ok(performance.now() - started < 1_000);
  assert.ok(timeout.getDiagnostics().traceExportFailures >= 1);
  await timeout.shutdown();
});

test("forceFlush 等待超时导出回调完成并记录诊断", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收真实 OTLP 请求。 */
    }
    if (request.url === "/metrics") {
      response.end("{}");
      return;
    }
    const timer = setTimeout(() => response.end("{}"), 300);
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const telemetry = createOtlpTelemetry({
    serviceName: "trace-timeout",
    tracesUrl: `${endpoint}/traces`,
    metricsUrl: `${endpoint}/metrics`,
    timeoutMs: 40,
  });
  t.after(() => telemetry.shutdown());
  telemetry.tracer.startSpan("may.run").end();
  const started = performance.now();
  await telemetry.forceFlush();
  assert.ok(performance.now() - started < 1_000);
  assert.equal(telemetry.getDiagnostics().traceExportFailures, 1);
});

test("CPU 高负载达到生命周期超时时记录未完成导出且不重复计数", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收真实 OTLP 请求。 */
    }
    if (request.url === "/metrics") {
      response.end("{}");
      return;
    }
    pbkdf2Sync("telemetry-load", "test-salt", 4_000_000, 32, "sha256");
    const timer = setTimeout(() => response.end("{}"), 300);
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const telemetry = createOtlpTelemetry({
    serviceName: "cpu-load",
    tracesUrl: `${endpoint}/traces`,
    metricsUrl: `${endpoint}/metrics`,
    timeoutMs: 40,
  });
  t.after(() => telemetry.shutdown());
  telemetry.tracer.startSpan("may.run").end();
  await telemetry.forceFlush();
  assert.equal(telemetry.getDiagnostics().traceExportFailures, 1);
  assert.equal(telemetry.getDiagnostics().lifecycleFailures, 1);
  await telemetry.shutdown();
  assert.equal(telemetry.getDiagnostics().traceExportFailures, 1);
});
