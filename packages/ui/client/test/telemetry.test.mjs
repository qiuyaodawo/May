import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTelemetryPanel } from "../dist/index.js";
import { BasicTracer, DiagnosticsStore, InMemorySpanProcessor, ratioSampler } from "../../../observability/dist/index.js";

test("telemetry panel displays independent real span durations, ongoing spans and local coverage", async () => {
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics, sampler: ratioSampler(0) });
  const parent = tracer.startSpan("may.run");
  const child = tracer.startSpan("may.model.call", { parent: parent.context });
  await delay(5);
  child.end({ status: "ok" });
  await delay(5);
  parent.end({ status: "ok" });
  const active = tracer.startSpan("may.tool.call");
  const data = diagnostics.getDiagnostics();
  const panel = createTelemetryPanel(data);
  assert.equal(panel.fields[0].value, "3 条本地记录，0 条已超过保留范围。");
  const finished = data.spans.filter(span => span.ended);
  assert.ok(finished.find(span => span.name === "may.run").durationMs >= finished.find(span => span.name === "may.model.call").durationMs);
  for (const span of finished) {
    const field = panel.fields.find(field => field.label.includes(span.name));
    assert.ok(field.value.includes(`${span.durationMs} ms`));
    assert.ok(field.value.includes(span.context.spanId));
  }
  assert.ok(panel.fields.find(field => field.label.includes("may.model.call")).value.includes(`parent ${parent.context.spanId}`));
  assert.match(panel.fields.find(field => field.label.includes("may.tool.call")).value, /正在执行 · 耗时尚未确定/);
  assert.ok(panel.fields.slice(1).every(field => field.value.includes("本地记录")));
  assert.ok(!JSON.stringify(panel).includes("总耗时"));
  active.end({ status: "cancelled" });
});

test("telemetry panel identifies retention and pagination bounds with real retained diagnostics", () => {
  const diagnostics = new DiagnosticsStore({ maxSpans: 2 });
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics });
  for (let index = 0; index < 3; index++) tracer.startSpan(`operation.${index}`).end({ status: "ok" });
  const data = diagnostics.getDiagnostics({ limit: 1 });
  assert.equal(data.total, 2);
  assert.equal(data.evictedSpans, 1);
  assert.equal(data.hasMore, true);
  const panel = createTelemetryPanel(data);
  assert.match(panel.fields[0].value, /2 条本地记录，1 条已超过保留范围，还有后续记录/);
  assert.equal(panel.fields.length, 2);
  assert.match(createTelemetryPanel(undefined).fields[0].value, /没有启用遥测/);
});
