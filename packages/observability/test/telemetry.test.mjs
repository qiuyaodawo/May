import assert from "node:assert/strict";
import test from "node:test";
import { createModelAttemptObserver, priceUsage } from "@sortedyuan/may/core";
import {
  BasicTracer,
  BoundedMetrics,
  DiagnosticsStore,
  InMemorySpanProcessor,
  alwaysOffSampler,
} from "../dist/index.js";

test("metrics and local diagnostics include unsampled operations, active spans, and bounded records", () => {
  const processor = new InMemorySpanProcessor();
  const metrics = new BoundedMetrics({ maxSeries: 16 });
  const observer = new DiagnosticsStore({ maxSpans: 3 });
  const tracer = new BasicTracer({ processor, observer, metrics, sampler: alwaysOffSampler });
  const run = tracer.startSpan("may.run", {
    attributes: { "may.run.id": "run", "may.task.id": "task", "may.session.id": "session" },
  });
  const call = tracer.startSpan("may.model.call", { parent: run.context });
  assert.equal(observer.getDiagnostics().spans.filter((span) => !span.ended).length, 2);
  call.end({
    attributes: {
      "may.model.attempts": 1,
      "may.model.first_content_ms": 4,
      "may.model.has_text": false,
      "may.model.usage_available": false,
    },
  });
  run.end();
  assert.equal(processor.getFinishedSpans().length, 0);
  assert.equal(observer.getDiagnostics({ sessionId: "session" }).spans.length, 2);
  assert.ok(observer.getDiagnostics().spans.every((span) => span.sampled === false));
  assert.equal(metrics.getMetrics().find((metric) => metric.name === "may.run.active").value, 0);
  assert.equal(metrics.getMetrics().find((metric) => metric.name === "may.model.call.count").value, 1);
  assert.equal(metrics.getMetrics().find((metric) => metric.name === "may.model.usage_missing").value, 1);
  observer.recordAssessment({
    taskId: "task",
    evaluator: "files",
    evaluatorVersion: "1",
    result: "passed",
    evidenceReferences: ["artifact:report"],
  });
  assert.equal(observer.getDiagnostics({ taskId: "task" }).assessments[0].result, "passed");
  assert.throws(() => observer.getDiagnostics({ limit: 501 }), RangeError);
  assert.throws(() => tracer.startSpan("example", { attributes: { prompt: "private" } }), TypeError);
  assert.throws(() => tracer.startSpan("example", { attributes: { value: "x".repeat(257) } }), RangeError);
  const attempt = createModelAttemptObserver({ tracer, modelCallId: "other" }).start(1);
  attempt.content("tool");
  attempt.end({ status: "ok", completed: true });
  const recorded = observer.getDiagnostics().spans.find((span) => span.name === "may.model.attempt");
  assert.equal(recorded.attributes["may.model.has_text"], false);
  assert.equal(recorded.attributes["may.model.first_text_ms"], undefined);
  assert.equal(observer.getDiagnostics().spans.length, 3);
  const refreshed = tracer.startSpan("may.model.call");
  refreshed.end({ attributes: { "may.model.provider": "updated" } });
  assert.ok(
    metrics
      .getMetrics()
      .filter((metric) => metric.name.endsWith(".active"))
      .every((metric) => metric.value === 0),
  );
});

test("assessment scope remains explicit or uniquely inferred across repeated task names and retained-span eviction", () => {
  const diagnostics = new DiagnosticsStore({ maxSpans: 2 });
  const tracer = new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics });
  const operation = (taskId, sessionId, coordinationId, runId) => {
    const span = tracer.startSpan("may.run", {
      attributes: {
        "may.task.id": taskId,
        "may.session.id": sessionId,
        "may.coordination.id": coordinationId,
        "may.run.id": runId,
      },
    });
    span.end({ status: "ok" });
    return span;
  };
  const first = operation("shared", "session-one", "coordination-one", "run-one");
  diagnostics.recordAssessment({ taskId: "shared", evaluator: "first", evaluatorVersion: "1", result: "passed" });
  operation("shared", "session-two", "coordination-two", "run-two");
  diagnostics.recordAssessment({
    taskId: "shared",
    evaluator: "ambiguous",
    evaluatorVersion: "1",
    result: "inconclusive",
  });
  diagnostics.recordAssessment({
    taskId: "shared",
    sessionId: "session-two",
    evaluator: "second",
    evaluatorVersion: "1",
    result: "failed",
  });
  const scoped = (query) => diagnostics.getDiagnostics(query).assessments.map((value) => value.evaluator);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-one" }), ["first"]);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-two" }), ["second"]);
  assert.deepEqual(scoped({ coordinationId: "coordination-one" }), ["first"]);
  assert.deepEqual(scoped({ traceId: first.context.traceId }), ["first"]);
  assert.deepEqual(scoped({ sessionId: "session-one", runId: "run-two" }), []);
  assert.deepEqual(scoped({ taskId: "shared" }), ["first", "ambiguous", "second"]);
  operation("different", "session-two", "coordination-two", "run-three");
  diagnostics.recordAssessment({
    taskId: "different",
    evaluator: "different",
    evaluatorVersion: "1",
    result: "passed",
  });
  assert.deepEqual(scoped({ taskId: "different", sessionId: "session-one" }), []);
  operation("other", "session-three", "coordination-three", "run-four");
  assert.equal(diagnostics.getDiagnostics({ taskId: "shared" }).spans.length, 0);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-one" }), ["first"]);
  assert.deepEqual(scoped({ taskId: "shared", sessionId: "session-two" }), ["second"]);
  assert.deepEqual(scoped({ taskId: "shared", coordinationId: "coordination-two", runId: "run-two" }), ["second"]);
  assert.deepEqual(scoped({ taskId: "shared" }), ["first", "ambiguous", "second"]);
  assert.throws(
    () =>
      diagnostics.recordAssessment({
        taskId: "shared",
        sessionId: "x".repeat(257),
        evaluator: "limits",
        evaluatorVersion: "1",
        result: "passed",
      }),
    RangeError,
  );
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
  for (const cost of costs)
    tracer.startSpan("may.model.call").end({
      attributes: {
        "may.model.cost": cost.amount,
        "may.model.currency": cost.currency,
        "may.model.cost_kind": cost.kind,
        "may.model.cost_complete": cost.complete,
      },
    });
  const values = metrics.getMetrics().filter((metric) => metric.name === "may.model.cost");
  assert.equal(values.length, 3);
  for (const cost of costs) {
    const value = values.find(
      (metric) => metric.attributes.cost_kind === cost.kind && metric.attributes.cost_complete === cost.complete,
    );
    assert.equal(value.value, cost.amount);
    assert.equal(value.attributes.currency, "USD");
  }
});
