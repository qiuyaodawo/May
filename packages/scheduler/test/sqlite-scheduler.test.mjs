import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { Scheduler } from "../dist/index.js";
import { DurableTaskHost } from "./fixtures/durable-host.mjs";
import { cleanupOperations, fixture } from "./fixtures/sqlite-fixture.mjs";

test("job identifiers preserve the complete supported length in durable identity metadata", async (t) => {
  const { scheduler } = await schedulerFixture(t);
  for (const length of [252, 253, 256]) {
    const id = "a".repeat(length);
    const created = await scheduler.createJob({
      id,
      enabled: true,
      trigger: { type: "event", topic: "length-validation" },
      task: { handler: "write-artifact", payload: { length } },
      misfire: { policy: "latest", graceMs: 1_000 },
    });
    assert.equal(created.id, id);
  }
  assert.equal((await scheduler.listJobs()).length, 3);
});

test("an immediate stop drains the initial background round without reporting a failure", async (t) => {
  const errors = [];
  const { scheduler } = await schedulerFixture(t, {
    onError(error) {
      errors.push(error);
    },
  });
  const started = scheduler.start();
  const stopped = scheduler.stop();
  const outcomes = await Promise.allSettled([started, stopped]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["fulfilled", "fulfilled"],
  );
  assert.deepEqual(errors, []);
  await scheduler.start();
  await scheduler.stop();
  assert.deepEqual(errors, []);
});

test("listing supported job payloads may return more than one individual record limit", async (t) => {
  const { scheduler, host } = await schedulerFixture(t);
  for (let index = 0; index < 20; index++) {
    await scheduler.createJob({
      id: `large-list-${index}`,
      enabled: true,
      trigger: { type: "event", topic: "large-list" },
      task: { handler: "write-artifact", payload: { text: "a".repeat(60_000) } },
      misfire: { policy: "latest", graceMs: 1_000 },
    });
  }
  const jobs = await scheduler.listJobs();
  assert.equal(jobs.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(jobs)) > 1024 * 1024);
  const published = await scheduler.publish({
    source: "sqlite-store-tests",
    id: "large-execution-page",
    topic: "large-list",
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  assert.equal(published.length, 20);
  const page = await scheduler.listExecutions({ limit: 20 });
  assert.equal(page.records.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024);
  assert.equal(host.tasks().length, 20);
  for (const task of host.tasks()) assert.equal(existsSync(task.artifact_path), true);
});

test("accepted ISO timestamp forms use the same parser during validation and persistence", async (t) => {
  const { scheduler } = await schedulerFixture(t);
  const created = await scheduler.createJob({
    id: "ordinal-timestamp",
    enabled: true,
    trigger: { type: "at", time: "2026-277T08:00:00+08:00" },
    task: { handler: "write-artifact", payload: {} },
    misfire: { policy: "latest", graceMs: 1_000 },
  });
  assert.equal(created.nextAt, "2026-10-04T00:00:00.000Z");
  assert.equal((await scheduler.listJobs()).length, 1);
});

test("the maximum supported payload depth survives time and event executions", async (t) => {
  const { scheduler, host } = await schedulerFixture(t);
  const payload = nestedPayload(60);
  const definition = {
    enabled: true,
    task: { handler: "write-artifact", payload },
    misfire: { policy: "latest", graceMs: 5_000 },
  };
  await scheduler.createJob({
    ...definition,
    id: "depth-time",
    trigger: { type: "at", time: new Date(Date.now() - 100).toISOString() },
  });
  await scheduler.createJob({ ...definition, id: "depth-event", trigger: { type: "event", topic: "depth" } });
  assert.equal((await scheduler.listJobs()).length, 2);
  const [eventExecution] = await scheduler.publish({
    source: "sqlite-store-tests",
    id: "maximum-depth",
    topic: "depth",
    occurredAt: new Date().toISOString(),
    payload,
  });
  assert.equal(eventExecution.status, "submitted");
  assert.deepEqual(eventExecution.job.task.payload, payload);
  assert.deepEqual(eventExecution.event.payload, payload);
  assert.equal((await scheduler.tick()).submitted, 1);
  const page = await scheduler.listExecutions();
  assert.equal(page.records.length, 2);
  for (const record of page.records) {
    assert.equal(record.status, "submitted");
    assert.deepEqual(record.job.task.payload, payload);
  }
  assert.equal(host.tasks().length, 2);
});

test("oversized and deeply nested public inputs fail before changing scheduler storage", async (t) => {
  const { scheduler, host } = await schedulerFixture(t);
  const base = {
    id: "valid-boundaries",
    enabled: true,
    trigger: { type: "event", topic: "boundaries" },
    task: { handler: "write-artifact", payload: {} },
    misfire: { policy: "latest", graceMs: 1_000 },
  };
  const created = await scheduler.createJob(base);
  for (const payload of [nestedPayload(61), "a".repeat(64 * 1024 - 1)]) {
    await assert.rejects(
      scheduler.createJob({ ...base, id: "invalid-boundaries", task: { handler: "write-artifact", payload } }),
      RangeError,
    );
    await assert.rejects(
      scheduler.updateJob(base.id, { task: { handler: "write-artifact", payload } }, created.revision),
      RangeError,
    );
    await assert.rejects(
      scheduler.publish({
        source: "sqlite-store-tests",
        id: "invalid-event",
        topic: "boundaries",
        occurredAt: new Date().toISOString(),
        payload,
      }),
      RangeError,
    );
    assert.equal((await scheduler.listJobs()).length, 1);
    assert.deepEqual((await scheduler.listExecutions()).records, []);
  }
  const [execution] = await scheduler.publish({
    source: "sqlite-store-tests",
    id: "valid-event",
    topic: "boundaries",
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  assert.equal(execution.status, "submitted");
  assert.equal(host.tasks().length, 1);
});

test("misfire policies require a supported string value", async (t) => {
  const { scheduler } = await schedulerFixture(t);
  await assert.rejects(
    scheduler.createJob({
      id: "invalid-policy",
      enabled: true,
      trigger: { type: "event", topic: "policies" },
      task: { handler: "write-artifact", payload: {} },
      misfire: { policy: ["latest"], graceMs: 1_000 },
    }),
    TypeError,
  );
  assert.deepEqual(await scheduler.listJobs(), []);
});

test("reopening requires a next occurrence for every enabled cron job", async (t) => {
  const { scheduler, host, path } = await schedulerFixture(t);
  const job = await scheduler.createJob({
    id: "required-next-occurrence",
    enabled: true,
    trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
    task: { handler: "write-artifact", payload: {} },
    misfire: { policy: "latest", graceMs: 1_000 },
  });
  assert.equal(typeof job.nextAt, "string");
  await scheduler.close();
  const store = SqliteSchedulerStore.open(path);
  cleanupOperations.get(t).push(() => store.close());
  const { nextAt, ...withoutNext } = job;
  store.put("jobs", job.id, withoutNext);
  assert.throws(() => Scheduler.open({ store, dispatcher: host }), /nextAt|occurrence/u);
});

async function schedulerFixture(t, options = {}) {
  const path = fixture(t);
  const store = SqliteSchedulerStore.open(path);
  cleanupOperations.get(t).push(() => store.close());
  const host = await DurableTaskHost.open(join(resolve(path, ".."), "host"));
  cleanupOperations.get(t).push(() => host.close());
  const scheduler = Scheduler.open({ store, dispatcher: host, ...options });
  cleanupOperations.get(t).push(() => scheduler.close());
  return { scheduler, store, host, path };
}

function nestedPayload(depth) {
  let payload = "leaf";
  for (let index = 0; index < depth; index++) payload = { child: payload };
  return payload;
}
