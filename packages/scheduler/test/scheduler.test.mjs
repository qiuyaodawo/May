import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { Scheduler } from "../dist/index.js";
import { latestTime, nextTime } from "../dist/triggers.js";
import { event, job, setup, verificationRoot, waitUntil } from "./fixtures/scheduler-setup.mjs";

test("opening a scheduler does not execute due jobs until tick", async (t) => {
  const { scheduler, host } = await setup(t, "explicit-start");
  const scheduledAt = new Date(Date.now() + 80).toISOString();
  await scheduler.createJob(job("explicit-start", { type: "at", time: scheduledAt }));
  await delay(120);
  assert.deepEqual((await scheduler.listExecutions()).records, []);
  assert.deepEqual(host.tasks(), []);
  const result = await scheduler.tick();
  assert.equal(result.created, 1);
  assert.equal(result.submitted, 1);
  const [execution] = (await scheduler.listExecutions()).records;
  assert.equal(execution.scheduledAt, scheduledAt);
  assert.equal(execution.status, "submitted");
  assert.equal(host.tasks().length, 1);
  assert.equal(JSON.parse(await readFile(host.tasks()[0].artifact_path, "utf8")).request.executionId, execution.id);
  assert.equal((await scheduler.tick()).created, 0);
  assert.equal(host.tasks().length, 1);
});

test("revisions, execution snapshots, pause and deletion remain durable", async (t) => {
  const { scheduler, host, path } = await setup(t, "job-management");
  const created = await scheduler.createJob(job("editable", { type: "event", topic: "tasks" }));
  assert.equal(created.revision, 1);
  const first = event("original");
  const [execution] = await scheduler.publish(first);
  const updated = await scheduler.updateJob(
    "editable",
    {
      task: { handler: "write-artifact", payload: { label: "updated" } },
      enabled: false,
    },
    created.revision,
  );
  assert.equal(updated.revision, created.revision + 1);
  await assert.rejects(scheduler.updateJob("editable", { enabled: true }, created.revision));
  await assert.rejects(scheduler.deleteJob("editable", created.revision));
  assert.deepEqual(await scheduler.publish(event("paused")), []);
  assert.deepEqual(await scheduler.publish(first), [execution]);
  await scheduler.tick();
  const [stored] = (await scheduler.listExecutions()).records;
  assert.deepEqual(stored.job.task.payload, { label: "editable" });
  await scheduler.deleteJob("editable", updated.revision);
  assert.deepEqual(await scheduler.listJobs(), []);
  assert.equal((await scheduler.listExecutions()).records.length, 1);
  assert.equal(host.tasks().length, 1);
  await assert.rejects(scheduler.createJob(job("editable", { type: "event", topic: "tasks" })));
  const page = await scheduler.listExecutions({ jobId: "editable", status: "submitted", limit: 1 });
  assert.equal(page.records.length, 1);
  assert.equal((await scheduler.listExecutions({ afterSeq: stored.seq })).records.length, 0);
  assert.ok(path.startsWith(verificationRoot));
});

test("event acceptance matches the active jobs once and rejects identity conflicts", async (t) => {
  const { scheduler, host } = await setup(t, "event-deduplication");
  await scheduler.createJob(job("original-job", { type: "event", topic: "tasks" }));
  const input = event("shared-event");
  const original = await scheduler.publish(input);
  await scheduler.createJob(job("later-job", { type: "event", topic: "tasks" }));
  const repeated = await Promise.all(Array.from({ length: 8 }, () => scheduler.publish(input)));
  for (const records of repeated) assert.deepEqual(records, original);
  await assert.rejects(scheduler.publish({ ...input, payload: { label: "conflicting" } }));
  assert.equal((await scheduler.listExecutions()).records.length, 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => scheduler.tick()));
  assert.equal(
    results.reduce((total, result) => total + result.submitted, 0),
    0,
  );
  assert.equal(host.tasks().length, 1);
});

test("an accepted event without matches stays accepted across new jobs", async (t) => {
  const { scheduler, host } = await setup(t, "event-no-matches");
  const input = event("no-match");
  assert.deepEqual(await scheduler.publish(input), []);
  await scheduler.createJob(job("new-job", { type: "event", topic: "tasks" }));
  assert.deepEqual(await scheduler.publish(input), []);
  await scheduler.tick();
  assert.deepEqual(host.tasks(), []);
});

test("skip and latest policies use the real scheduled time and grace interval", async (t) => {
  const { scheduler, host } = await setup(t, "misfire");
  const scheduledAt = new Date(Date.now() + 80).toISOString();
  const trigger = { type: "at", time: scheduledAt };
  await scheduler.createJob(job("skip-late", trigger, { misfire: { policy: "skip", graceMs: 0 } }));
  await scheduler.createJob(job("latest-expired", trigger, { misfire: { policy: "latest", graceMs: 30 } }));
  await scheduler.createJob(job("latest-allowed", trigger, { misfire: { policy: "latest", graceMs: 10_000 } }));
  await delay(150);
  const result = await scheduler.tick();
  assert.equal(result.created, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.submitted, 1);
  const records = (await scheduler.listExecutions()).records;
  assert.equal(records.find((record) => record.job.id === "latest-allowed").status, "submitted");
  assert.equal(records.find((record) => record.job.id === "skip-late").status, "skipped");
  assert.equal(records.find((record) => record.job.id === "latest-expired").status, "skipped");
  for (const record of records) assert.equal(record.scheduledAt, scheduledAt);
  assert.equal(host.tasks().length, 1);
});

test("timezone and daylight-saving transitions use the documented local times", () => {
  const dailyShanghai = { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" };
  assert.equal(
    new Date(nextTime(dailyShanghai, Date.parse("2026-10-04T00:00:00Z"))).toISOString(),
    "2026-10-05T00:00:00.000Z",
  );
  const missingTime = { type: "cron", expression: "30 2 * * *", timezone: "America/New_York" };
  assert.equal(
    new Date(nextTime(missingTime, Date.parse("2026-03-08T06:59:00Z"))).toISOString(),
    "2026-03-09T06:30:00.000Z",
  );
  const repeatedTime = { type: "cron", expression: "30 1 * * *", timezone: "America/New_York" };
  const first = nextTime(repeatedTime, Date.parse("2026-11-01T04:59:00Z"));
  assert.equal(new Date(first).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(nextTime(repeatedTime, Date.parse(first))).toISOString(), "2026-11-02T06:30:00.000Z");
  assert.equal(
    latestTime(dailyShanghai, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-04T03:00:00Z")),
    "2026-10-04T00:00:00.000Z",
  );
  assert.equal(
    latestTime(missingTime, Date.parse("2026-03-07T07:30:00Z"), Date.parse("2026-03-08T08:00:00Z")),
    undefined,
  );
  assert.equal(
    latestTime(repeatedTime, Date.parse("2026-11-01T05:30:00Z"), Date.parse("2026-11-01T07:00:00Z")),
    undefined,
  );
});

test("submission concurrency is bounded and accepted tasks are real durable artifacts", async (t) => {
  const { scheduler, host } = await setup(t, "submission-concurrency", {
    maxConcurrentSubmissions: 2,
    acknowledgementDelayMs: 60,
  });
  await scheduler.createJob(job("concurrent", { type: "event", topic: "tasks" }));
  await Promise.all(Array.from({ length: 6 }, (_, index) => scheduler.publish(event(`event-${index}`))));
  const result = await scheduler.tick();
  assert.equal(result.submitted, 0);
  assert.equal(host.tasks().length, 6);
  assert.equal(host.maxActiveSubmissions, 2);
  assert.equal(host.activeSubmissions, 0);
  for (const row of host.tasks()) {
    const artifact = JSON.parse(await readFile(row.artifact_path, "utf8"));
    assert.equal(artifact.taskId, row.task_id);
  }
});

test("an explicit task rejection records failed and does not replay the rejection", async (t) => {
  const { scheduler, host } = await setup(t, "task-rejection");
  await scheduler.createJob(
    job(
      "rejected",
      { type: "event", topic: "tasks" },
      {
        task: { handler: "unregistered-handler", payload: {} },
      },
    ),
  );
  const [rejected] = await scheduler.publish(event("rejected-event"));
  assert.equal(rejected.status, "failed");
  assert.equal((await scheduler.listExecutions()).records[0].status, "failed");
  assert.equal((await scheduler.tick()).failed, 0);
  assert.deepEqual(host.tasks(), []);
});

test("start requires explicit activation, excludes manual tick and stop drains submissions", async (t) => {
  const { scheduler, host } = await setup(t, "service-lifecycle", { acknowledgementDelayMs: 100 });
  const scheduledAt = new Date(Date.now() + 150).toISOString();
  await scheduler.createJob(job("service-job", { type: "at", time: scheduledAt }));
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(3_000) });
  await scheduler.start();
  await assert.rejects(async () => scheduler.tick());
  await accepted;
  const stopping = scheduler.stop();
  await assert.rejects(async () => scheduler.publish(event("during-stop")));
  await stopping;
  assert.equal(host.activeSubmissions, 0);
  assert.equal((await scheduler.listExecutions()).records[0].status, "submitted");
  assert.equal(host.tasks().length, 1);
  await scheduler.tick();
});

test("stop leaves queued submissions pending and an explicit tick resumes them", async (t) => {
  const { scheduler, host } = await setup(t, "queued-stop", {
    acknowledgementDelayMs: 100,
    maxConcurrentSubmissions: 1,
  });
  const scheduledAt = new Date(Date.now() + 60).toISOString();
  await scheduler.createJob(job("first-queued", { type: "at", time: scheduledAt }));
  await scheduler.createJob(job("second-queued", { type: "at", time: scheduledAt }));
  await delay(90);
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(3_000) });
  const ticking = scheduler.tick();
  await accepted;
  await assert.rejects(async () => scheduler.start());
  const stopping = scheduler.stop();
  const result = await ticking;
  await stopping;
  assert.equal(result.created, 2);
  assert.equal(result.submitted, 1);
  assert.equal(host.tasks().length, 1);
  assert.deepEqual(
    (await scheduler.listExecutions()).records.map((record) => record.status),
    ["submitted", "pending"],
  );
  await assert.rejects(async () => scheduler.publish(event("after-stop")));
  assert.equal((await scheduler.tick()).submitted, 1);
  assert.equal(host.tasks().length, 2);
});

test("an immediate stop excludes restart until drained and a subsequent start runs the timer", async (t) => {
  const { scheduler, host } = await setup(t, "immediate-restart");
  await scheduler.createJob(
    job("restart-timer", {
      type: "at",
      time: new Date(Date.now() + 100).toISOString(),
    }),
  );
  const starting = scheduler.start();
  const stopping = scheduler.stop();
  await assert.rejects(async () => scheduler.start(), /stop/u);
  await stopping;
  await starting;
  assert.deepEqual(host.tasks(), []);
  await scheduler.start();
  await waitUntil(async () => (await scheduler.listExecutions()).records[0]?.status === "submitted");
  assert.equal(host.tasks().length, 1);
  await scheduler.stop();
});

test("execution pages preserve sequence order, filters and cursor bounds", async (t) => {
  const { scheduler, host } = await setup(t, "execution-pages");
  await scheduler.createJob(job("paged-job", { type: "event", topic: "tasks" }));
  await Promise.all(Array.from({ length: 105 }, (_, index) => scheduler.publish(event(`page-${index}`))));
  const first = await scheduler.listExecutions();
  assert.equal(first.records.length, 100);
  assert.equal(first.nextAfterSeq, first.records.at(-1).seq);
  const second = await scheduler.listExecutions({ afterSeq: first.nextAfterSeq });
  assert.equal(second.records.length, 5);
  assert.equal(second.nextAfterSeq, undefined);
  assert.equal(new Set([...first.records, ...second.records].map((record) => record.id)).size, 105);
  assert.equal(host.tasks().length, 105);
  assert.equal(
    (await scheduler.listExecutions({ jobId: "paged-job", status: "submitted", limit: 1000 })).records.length,
    105,
  );
  assert.equal((await scheduler.listExecutions({ status: "pending" })).records.length, 0);
  assert.equal((await scheduler.listExecutions({ jobId: "unmatched" })).records.length, 0);
  await assert.rejects(scheduler.listExecutions({ limit: 0 }));
  await assert.rejects(scheduler.listExecutions({ limit: 1001 }));
  await assert.rejects(scheduler.listExecutions({ afterSeq: -1 }));
});

test("rejects invalid trigger, payload and concurrency before executing tasks", async (t) => {
  const { scheduler, host, store } = await setup(t, "invalid-definitions");
  assert.throws(() => Scheduler.open({ store, dispatcher: host, maxConcurrentSubmissions: 0 }));
  assert.throws(() => Scheduler.open({ store, dispatcher: host, maxConcurrentSubmissions: 1.5 }));
  await assert.rejects(scheduler.createJob(job("missing-offset", { type: "at", time: "2026-10-04T08:00:00" })));
  await assert.rejects(
    scheduler.createJob(job("invalid-cron", { type: "cron", expression: "bad expression", timezone: "Asia/Shanghai" })),
  );
  await assert.rejects(
    scheduler.createJob(
      job("invalid-timezone", { type: "cron", expression: "0 8 * * *", timezone: "Unknown/Timezone" }),
    ),
  );
  await assert.rejects(
    scheduler.createJob(
      job(
        "invalid-payload",
        { type: "event", topic: "tasks" },
        {
          task: { handler: "write-artifact", payload: { value: Infinity } },
        },
      ),
    ),
  );
  await assert.rejects(
    scheduler.createJob(
      job(
        "invalid-grace",
        { type: "event", topic: "tasks" },
        {
          misfire: { policy: "latest", graceMs: -1 },
        },
      ),
    ),
  );
  const invalidTopics = ["t".repeat(257), "tasks\u0000", "tasks\u001f", "tasks\u007f"];
  for (const [index, topic] of invalidTopics.entries()) {
    await assert.rejects(scheduler.createJob(job(`invalid-topic-${index}`, { type: "event", topic })));
  }
  assert.deepEqual(await scheduler.listJobs(), []);
  assert.deepEqual(host.tasks(), []);
  const topic = "t".repeat(256);
  const valid = await scheduler.createJob(job("valid-topic-boundary", { type: "event", topic }));
  for (const invalidTopic of invalidTopics) {
    await assert.rejects(
      scheduler.updateJob(
        valid.id,
        {
          trigger: { type: "event", topic: invalidTopic },
        },
        valid.revision,
      ),
    );
  }
  const [stored] = await scheduler.listJobs();
  assert.equal(stored.revision, valid.revision);
  assert.deepEqual(stored.trigger, { type: "event", topic });
  const [execution] = await scheduler.publish(event("valid-topic-boundary", topic));
  assert.equal(execution.status, "submitted");
  assert.equal(execution.job.trigger.topic, topic);
  assert.equal(host.tasks().length, 1);
  for (const occurredAt of ["10:00Z", "2026-10-04"]) {
    await assert.rejects(scheduler.publish({ ...event(`invalid-time-${occurredAt}`, topic), occurredAt }));
  }
  assert.equal((await scheduler.listExecutions()).records.length, 1);
  const ordinalTimestamp = "2026-277T10:00:00Z";
  const [ordinalExecution] = await scheduler.publish({
    ...event("ordinal-event-time", topic),
    occurredAt: ordinalTimestamp,
  });
  assert.equal(ordinalExecution.status, "submitted");
  assert.equal(ordinalExecution.event.occurredAt, ordinalTimestamp);
  assert.equal(host.tasks().length, 2);
});
