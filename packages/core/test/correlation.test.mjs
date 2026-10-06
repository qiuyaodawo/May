import assert from "node:assert/strict";
import test from "node:test";
import { correlationTraceAttributes, validateTelemetryCorrelation } from "../dist/index.js";

test("telemetry correlation validates versioned identities and freezes the transport snapshot", () => {
  const input = { version: 1, taskId: "task", coordinationId: "coordination", dispatchId: "dispatch", schedulerExecutionId: "schedule",
    resumedFromRunId: "previous-run", parent: { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", sampled: true } };
  const correlation = validateTelemetryCorrelation(input);
  input.taskId = "changed";
  input.parent.spanId = "abcdef1234567890";
  assert.equal(correlation.taskId, "task");
  assert.equal(correlation.parent.spanId, "1234567890abcdef");
  assert.ok(Object.isFrozen(correlation));
  assert.ok(Object.isFrozen(correlation.parent));
  assert.deepEqual(correlationTraceAttributes(correlation), { "may.correlation.version": 1, "may.task.id": "task", "may.coordination.id": "coordination",
    "may.dispatch.id": "dispatch", "may.scheduler.execution_id": "schedule", "may.run.resumed_from": "previous-run" });
});

test("telemetry correlation rejects unsupported transport and unbounded identities", () => {
  for (const value of [null, [], { version: 2 }, { version: 1, prompt: "private" }, { version: 1, taskId: "" },
    { version: 1, taskId: "x".repeat(257) }, { version: 1, taskId: "task\nbody" },
    { version: 1, parent: { traceId: "0".repeat(32), spanId: "1".repeat(16) } },
    { version: 1, parent: { traceId: "1".repeat(32), spanId: "0".repeat(16) } },
    { version: 1, parent: { traceId: "1".repeat(32), spanId: "1".repeat(16), sampled: "yes" } },
    { version: 1, parent: { traceId: "1".repeat(32), spanId: "1".repeat(16), credentials: "private" } }]) assert.throws(() => validateTelemetryCorrelation(value), TypeError);
  assert.deepEqual(validateTelemetryCorrelation({ version: 1 }), { version: 1 });
});
