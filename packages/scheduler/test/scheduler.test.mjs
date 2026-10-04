import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Scheduler } from "../dist/index.js";
import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { latestTime, nextTime } from "../dist/triggers.js";
import { DurableTaskHost, HttpTaskDispatcher } from "./fixtures/durable-host.mjs";

const verificationRoot = fileURLToPath(new URL("../../../scheduler-verification/", import.meta.url));

async function directory(name) {
  await mkdir(verificationRoot, { recursive: true });
  return mkdtemp(join(verificationRoot, `${name}-`));
}

async function setup(t, name, options = {}) {
  const path = await directory(name);
  const host = await DurableTaskHost.open(join(path, "host"), options);
  const store = await SqliteSchedulerStore.open(join(path, "scheduler.sqlite"));
  const backgroundErrors = [];
  const scheduler = await Scheduler.open({
    store,
    dispatcher: host,
    maxConcurrentSubmissions: options.maxConcurrentSubmissions,
    onError: options.onError ?? ((error) => { backgroundErrors.push(error); }),
  });
  t.after(async () => {
    await scheduler.close();
    await host.close();
    assert.deepEqual(backgroundErrors, []);
  });
  return { path, scheduler, host, store };
}

function job(id, trigger, options = {}) {
  return {
    id,
    enabled: true,
    trigger,
    task: { handler: "write-artifact", payload: { label: id } },
    misfire: { policy: "latest", graceMs: 60_000 },
    ...options,
  };
}

function event(id, topic = "tasks") {
  return {
    source: "scheduler-test",
    id,
    topic,
    occurredAt: new Date().toISOString(),
    payload: { label: id },
  };
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("The operation did not finish before the deadline.");
    await delay(10);
  }
}

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
  const updated = await scheduler.updateJob("editable", {
    task: { handler: "write-artifact", payload: { label: "updated" } },
    enabled: false,
  }, created.revision);
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
  assert.equal(results.reduce((total, result) => total + result.submitted, 0), 0);
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
  assert.equal(new Date(nextTime(dailyShanghai, Date.parse("2026-10-04T00:00:00Z"))).toISOString(), "2026-10-05T00:00:00.000Z");
  const missingTime = { type: "cron", expression: "30 2 * * *", timezone: "America/New_York" };
  assert.equal(new Date(nextTime(missingTime, Date.parse("2026-03-08T06:59:00Z"))).toISOString(), "2026-03-09T06:30:00.000Z");
  const repeatedTime = { type: "cron", expression: "30 1 * * *", timezone: "America/New_York" };
  const first = nextTime(repeatedTime, Date.parse("2026-11-01T04:59:00Z"));
  assert.equal(new Date(first).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(nextTime(repeatedTime, Date.parse(first))).toISOString(), "2026-11-02T06:30:00.000Z");
  assert.equal(latestTime(dailyShanghai, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-04T03:00:00Z")), "2026-10-04T00:00:00.000Z");
  assert.equal(latestTime(missingTime, Date.parse("2026-03-07T07:30:00Z"), Date.parse("2026-03-08T08:00:00Z")), undefined);
  assert.equal(latestTime(repeatedTime, Date.parse("2026-11-01T05:30:00Z"), Date.parse("2026-11-01T07:00:00Z")), undefined);
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
  await scheduler.createJob(job("rejected", { type: "event", topic: "tasks" }, {
    task: { handler: "unregistered-handler", payload: {} },
  }));
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
  assert.deepEqual((await scheduler.listExecutions()).records.map((record) => record.status), ["submitted", "pending"]);
  await assert.rejects(async () => scheduler.publish(event("after-stop")));
  assert.equal((await scheduler.tick()).submitted, 1);
  assert.equal(host.tasks().length, 2);
});

test("an immediate stop excludes restart until drained and a subsequent start runs the timer", async (t) => {
  const { scheduler, host } = await setup(t, "immediate-restart");
  await scheduler.createJob(job("restart-timer", {
    type: "at",
    time: new Date(Date.now() + 100).toISOString(),
  }));
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
  assert.equal((await scheduler.listExecutions({ jobId: "paged-job", status: "submitted", limit: 1000 })).records.length, 105);
  assert.equal((await scheduler.listExecutions({ status: "pending" })).records.length, 0);
  assert.equal((await scheduler.listExecutions({ jobId: "unmatched" })).records.length, 0);
  await assert.rejects(scheduler.listExecutions({ limit: 0 }));
  await assert.rejects(scheduler.listExecutions({ limit: 1001 }));
  await assert.rejects(scheduler.listExecutions({ afterSeq: -1 }));
});

test("one scheduler storage rejects simultaneous owners and releases ownership on close", async (t) => {
  const path = await directory("storage-ownership");
  const databasePath = join(path, "scheduler.sqlite");
  const first = await SqliteSchedulerStore.open(databasePath);
  t.after(() => first.close());
  await assert.rejects(async () => SqliteSchedulerStore.open(databasePath));
  await first.close();
  const second = await SqliteSchedulerStore.open(databasePath);
  await second.close();
});

test("pending records survive a real scheduler process interruption", async (t) => {
  const path = await directory("pending-recovery");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 1_000 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(5_000) });
  const child = fork(fileURLToPath(new URL("./fixtures/crash-scheduler.mjs", import.meta.url)), [databasePath, endpoint, "pending"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exit = once(child, "exit");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await accepted;
  child.kill("SIGKILL");
  await exit;
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(databasePath),
    dispatcher: host,
  });
  t.after(() => scheduler.close());
  const pending = (await scheduler.listExecutions()).records.find((record) => record.status === "pending");
  assert.ok(pending, errors);
  assert.equal(pending.status, "pending");
  assert.equal((await scheduler.tick()).submitted, 2);
  assert.equal(host.tasks().length, 2);
  assert.equal((await scheduler.listExecutions()).records.find((record) => record.id === pending.id).status, "submitted");
});

test("a process interruption after host acceptance recovers with the identical executionId", async (t) => {
  const path = await directory("dispatch-recovery");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 1_000 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(5_000) });
  const child = fork(fileURLToPath(new URL("./fixtures/crash-scheduler.mjs", import.meta.url)), [databasePath, endpoint], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exit = once(child, "exit");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [receipt] = await accepted;
  child.kill("SIGKILL");
  await exit;
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(databasePath),
    dispatcher: new HttpTaskDispatcher(endpoint),
  });
  t.after(() => scheduler.close());
  const [interrupted] = (await scheduler.listExecutions()).records;
  assert.equal(interrupted.status, "dispatching");
  assert.equal(interrupted.id, receipt.request.executionId);
  assert.equal((await scheduler.tick()).submitted, 1);
  const [recovered] = (await scheduler.listExecutions()).records;
  assert.equal(recovered.id, interrupted.id);
  assert.equal(recovered.taskId, receipt.taskId);
  assert.equal(recovered.status, "submitted");
  assert.equal(host.tasks().length, 1);
});

test("closed schedulers reject operations and reopen the persisted definitions", async (t) => {
  const path = await directory("closed-resource");
  const host = await DurableTaskHost.open(join(path, "host"));
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const scheduler = await Scheduler.open({ store: await SqliteSchedulerStore.open(databasePath), dispatcher: host });
  await scheduler.createJob(job("persisted", { type: "event", topic: "tasks" }));
  await scheduler.close();
  await assert.rejects(async () => scheduler.tick());
  await assert.rejects(async () => scheduler.start());
  await assert.rejects(async () => scheduler.publish(event("closed")));
  const reopened = await Scheduler.open({ store: await SqliteSchedulerStore.open(databasePath), dispatcher: host });
  t.after(() => reopened.close());
  assert.equal((await reopened.listJobs())[0].id, "persisted");
});

test("maximum-length public identifiers remain valid across persistence and deletion", async (t) => {
  const path = await directory("identifier-boundaries");
  const host = await DurableTaskHost.open(join(path, "host"));
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const scheduler = await Scheduler.open({ store: await SqliteSchedulerStore.open(databasePath), dispatcher: host });
  t.after(() => scheduler.close());
  const id = "j".repeat(256);
  const topic = "t".repeat(256);
  const created = await scheduler.createJob(job(id, { type: "event", topic }));
  const input = { ...event("e".repeat(256), topic), source: "s".repeat(256) };
  const [execution] = await scheduler.publish(input);
  assert.equal(execution.job.id, id);
  await scheduler.deleteJob(id, created.revision);
  await scheduler.close();
  const reopened = await Scheduler.open({ store: await SqliteSchedulerStore.open(databasePath), dispatcher: host });
  t.after(() => reopened.close());
  const [repeated] = await reopened.publish(input);
  assert.equal(repeated.id, execution.id);
  await assert.rejects(reopened.createJob(job(id, { type: "event", topic })));
  assert.deepEqual(await reopened.listJobs(), []);
  assert.equal(host.tasks().length, 1);
});

test("an actual HTTP acknowledgement timeout leaves dispatching and recovers the accepted task", async (t) => {
  const path = await directory("http-timeout");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(databasePath),
    dispatcher: new HttpTaskDispatcher(endpoint, { timeoutMs: 40 }),
  });
  t.after(() => scheduler.close());
  await scheduler.createJob(job("timeout-task", { type: "event", topic: "tasks" }));
  const input = event("timeout-event");
  await assert.rejects(scheduler.publish(input), { name: "TimeoutError" });
  const [uncertain] = (await scheduler.listExecutions()).records;
  assert.equal(uncertain.status, "dispatching");
  assert.equal(host.tasks().length, 1);
  const taskId = host.tasks()[0].task_id;
  await scheduler.close();
  const recovered = await Scheduler.open({
    store: await SqliteSchedulerStore.open(databasePath),
    dispatcher: new HttpTaskDispatcher(endpoint),
  });
  t.after(() => recovered.close());
  const [confirmed] = await recovered.publish(input);
  assert.equal(confirmed.id, uncertain.id);
  assert.equal(confirmed.taskId, taskId);
  assert.equal(confirmed.status, "submitted");
  assert.equal(host.tasks().length, 1);
});

test("a real storage failure stops the timer and reports the error to the host", async (t) => {
  const reported = [];
  const { scheduler, host, store } = await setup(t, "storage-failure", {
    onError(error) { reported.push(error); },
  });
  await scheduler.createJob(job("storage-failure", {
    type: "at",
    time: new Date(Date.now() + 80).toISOString(),
  }));
  await scheduler.start();
  store.close();
  await waitUntil(() => reported.length > 0);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /closed/u);
  await assert.rejects(async () => scheduler.start(), /closed/u);
  await assert.rejects(scheduler.listJobs(), /closed/u);
  await delay(100);
  assert.equal(reported.length, 1);
  assert.deepEqual(host.tasks(), []);
});

test("a service-mode event communication error stops timers until explicit recovery", async (t) => {
  const path = await directory("service-transport-error");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const reported = [];
  const dispatcher = new HttpTaskDispatcher(endpoint, { timeoutMs: 40 });
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(join(path, "scheduler.sqlite")),
    dispatcher,
    onError(error) { reported.push(error); },
  });
  t.after(() => scheduler.close());
  await scheduler.createJob(job("event-error", { type: "event", topic: "tasks" }));
  await scheduler.createJob(job("timer-after-error", { type: "at", time: new Date(Date.now() + 130).toISOString() }));
  await scheduler.start();
  await assert.rejects(scheduler.publish(event("service-timeout")), { name: "TimeoutError" });
  assert.equal(reported.length, 1);
  assert.equal(reported[0].name, "TimeoutError");
  const acceptedId = host.tasks()[0].execution_id;
  const acceptedTaskId = host.tasks()[0].task_id;
  await assert.rejects(async () => scheduler.publish(event("service-stopped")));
  await delay(160);
  assert.equal(host.tasks().length, 1);
  assert.equal((await scheduler.listExecutions()).records.length, 1);
  dispatcher.timeoutMs = undefined;
  assert.equal((await scheduler.tick()).submitted, 2);
  const recovered = (await scheduler.listExecutions()).records.find((record) => record.id === acceptedId);
  assert.equal(recovered.status, "submitted");
  assert.equal(recovered.taskId, acceptedTaskId);
  assert.equal(host.tasks().length, 2);
  assert.equal(reported.length, 1);
});

test("an error callback can immediately restart the scheduler and resume its real timers", async (t) => {
  const path = await directory("callback-restart");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const dispatcher = new HttpTaskDispatcher(endpoint, { timeoutMs: 40 });
  const reported = [];
  let restarting;
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(join(path, "scheduler.sqlite")),
    dispatcher,
    onError(error) {
      reported.push(error);
      dispatcher.timeoutMs = undefined;
      restarting = scheduler.start();
    },
  });
  t.after(() => scheduler.close());
  const startedAt = Date.now();
  const recoveringAt = new Date(startedAt + 80).toISOString();
  const followingAt = new Date(startedAt + 250).toISOString();
  await scheduler.createJob(job("timer-recovery", { type: "at", time: recoveringAt }));
  await scheduler.createJob(job("timer-after-restart", { type: "at", time: followingAt }));
  await scheduler.start();
  await waitUntil(async () => {
    const records = (await scheduler.listExecutions()).records;
    return records.length === 2 && records.every((record) => record.status === "submitted");
  });
  await restarting;
  assert.equal(reported.length, 1);
  assert.equal(reported[0].name, "TimeoutError");
  const records = (await scheduler.listExecutions()).records;
  assert.equal(records.find((record) => record.job.id === "timer-recovery").scheduledAt, recoveringAt);
  assert.equal(records.find((record) => record.job.id === "timer-after-restart").scheduledAt, followingAt);
  const tasks = host.tasks();
  assert.equal(tasks.length, 2);
  for (const row of tasks) {
    const request = JSON.parse(row.request_json);
    assert.ok(Date.parse(row.accepted_at) >= Date.parse(request.scheduledAt));
    assert.equal(records.find((record) => record.id === request.executionId).taskId, row.task_id);
  }
  await scheduler.stop();
});

test("a real error-report write failure terminates the child and preserves recoverable dispatching", async (t) => {
  const path = await directory("error-handler-termination");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const reportPath = join(path, "unwritable-report.json");
  await mkdir(reportPath);
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(5_000) });
  const child = fork(fileURLToPath(new URL("./fixtures/failing-error-handler.mjs", import.meta.url)), [databasePath, endpoint, reportPath], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [receipt] = await accepted;
  const [exitCode, signal] = await exit;
  assert.equal(signal, null, stderr);
  assert.ok(exitCode > 0, stderr);
  assert.match(stderr, /(?:EISDIR|EPERM|EACCES)/u);
  assert.match(stderr, /unwritable-report\.json/u);
  assert.match(stderr, /failing-error-handler\.mjs/u);
  const scheduler = Scheduler.open({
    store: SqliteSchedulerStore.open(databasePath),
    dispatcher: new HttpTaskDispatcher(endpoint),
  });
  t.after(() => scheduler.close());
  const [interrupted] = (await scheduler.listExecutions()).records;
  assert.equal(interrupted.status, "dispatching");
  assert.equal(interrupted.id, receipt.request.executionId);
  assert.equal((await scheduler.tick()).submitted, 1);
  const [recovered] = (await scheduler.listExecutions()).records;
  assert.equal(recovered.id, interrupted.id);
  assert.equal(recovered.taskId, receipt.taskId);
  assert.equal(recovered.status, "submitted");
  assert.equal(host.tasks().length, 1);
  await writeFile(join(path, "failure-evidence.json"), `${JSON.stringify({
    exitCode,
    signal,
    stdout,
    stderr,
    interrupted,
    recovered,
    taskArtifactPath: receipt.artifactPath,
  }, null, 2)}\n`);
});

test("rejects invalid trigger, payload and concurrency before executing tasks", async (t) => {
  const { scheduler, host, store } = await setup(t, "invalid-definitions");
  assert.throws(() => Scheduler.open({ store, dispatcher: host, maxConcurrentSubmissions: 0 }));
  assert.throws(() => Scheduler.open({ store, dispatcher: host, maxConcurrentSubmissions: 1.5 }));
  await assert.rejects(scheduler.createJob(job("missing-offset", { type: "at", time: "2026-10-04T08:00:00" })));
  await assert.rejects(scheduler.createJob(job("invalid-cron", { type: "cron", expression: "bad expression", timezone: "Asia/Shanghai" })));
  await assert.rejects(scheduler.createJob(job("invalid-timezone", { type: "cron", expression: "0 8 * * *", timezone: "Unknown/Timezone" })));
  await assert.rejects(scheduler.createJob(job("invalid-payload", { type: "event", topic: "tasks" }, {
    task: { handler: "write-artifact", payload: { value: Infinity } },
  })));
  await assert.rejects(scheduler.createJob(job("invalid-grace", { type: "event", topic: "tasks" }, {
    misfire: { policy: "latest", graceMs: -1 },
  })));
  const invalidTopics = ["t".repeat(257), "tasks\u0000", "tasks\u001f", "tasks\u007f"];
  for (const [index, topic] of invalidTopics.entries()) {
    await assert.rejects(scheduler.createJob(job(`invalid-topic-${index}`, { type: "event", topic })));
  }
  assert.deepEqual(await scheduler.listJobs(), []);
  assert.deepEqual(host.tasks(), []);
  const topic = "t".repeat(256);
  const valid = await scheduler.createJob(job("valid-topic-boundary", { type: "event", topic }));
  for (const invalidTopic of invalidTopics) {
    await assert.rejects(scheduler.updateJob(valid.id, {
      trigger: { type: "event", topic: invalidTopic },
    }, valid.revision));
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
