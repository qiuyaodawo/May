import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BasicTracer, DiagnosticsStore } from "../../observability/dist/index.js";
import { Scheduler } from "../dist/index.js";
import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { DurableTaskHost, HttpTaskDispatcher } from "./fixtures/durable-host.mjs";

test("scheduler propagates versioned correlation through SQLite and HTTP task submission", { timeout: 10_000 }, async t => {
  const parentDirectory = fileURLToPath(new URL("../../../review/correlation-tests/", import.meta.url));
  await mkdir(parentDirectory, { recursive: true });
  const directory = await mkdtemp(join(parentDirectory, "scheduler-"));
  const host = await DurableTaskHost.open(join(directory, "host"));
  const endpoint = await host.listen();
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ processor: diagnostics, observer: diagnostics });
  const parent = tracer.startSpan("host.scheduler");
  const scheduler = Scheduler.open({ store: SqliteSchedulerStore.open(join(directory, "scheduler.sqlite")), dispatcher: new HttpTaskDispatcher(endpoint),
    tracer, telemetry: { version: 1, parent: parent.context, taskId: "scheduled-task" } });
  t.after(async () => { await scheduler.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  await scheduler.createJob({ id: "correlated", enabled: true, trigger: { type: "event", topic: "checks" },
    task: { handler: "write-artifact", payload: { operation: "check" } }, misfire: { policy: "latest", graceMs: 60_000 } });
  await scheduler.publish({ source: "local-test", id: "event-one", topic: "checks", occurredAt: new Date().toISOString(), payload: {} });
  const record = (await scheduler.listExecutions()).records[0];
  assert.equal(record.status, "submitted");
  const submission = JSON.parse(await readFile(host.tasks()[0].artifact_path, "utf8")).request;
  assert.equal(submission.telemetry.version, 1);
  assert.equal(submission.telemetry.schedulerExecutionId, record.id);
  assert.equal(submission.telemetry.taskId, "scheduled-task");
  const span = diagnostics.getDiagnostics({ traceId: parent.context.traceId }).spans.find(value => value.name === "may.scheduler.submit");
  assert.equal(span.parentSpanId, parent.context.spanId);
  assert.equal(submission.telemetry.parent.spanId, span.context.spanId);
  assert.equal(span.attributes["may.scheduler.execution_id"], record.id);
  assert.equal(span.attributes["may.task.id"], record.taskId);
  assert.equal(span.ended, true);
  const repeat = await new HttpTaskDispatcher(endpoint).submit({ ...submission, telemetry: { ...submission.telemetry,
    parent: { ...submission.telemetry.parent, spanId: "1234567890abcdef" } } });
  assert.equal(repeat.taskId, record.taskId);
  assert.equal(host.tasks().length, 1);
  parent.end({ status: "ok" });
});
