import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Scheduler } from "../dist/index.js";
import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { DurableTaskHost, HttpTaskDispatcher } from "./fixtures/durable-host.mjs";
import { directory, event, job, setup, waitUntil } from "./fixtures/scheduler-setup.mjs";

function acknowledgementTimeout(t, host) {
  const controller = new AbortController();
  let timeout;
  const onTimeout = () => controller.abort(timeout.reason);
  const onAccepted = () => {
    timeout = AbortSignal.timeout(0);
    timeout.addEventListener("abort", onTimeout, { once: true });
  };
  host.once("accepted", onAccepted);
  t.after(() => {
    host.off("accepted", onAccepted);
    timeout?.removeEventListener("abort", onTimeout);
  });
  return AbortSignal.any([controller.signal, t.signal]);
}

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
  const child = fork(
    fileURLToPath(new URL("./fixtures/crash-scheduler.mjs", import.meta.url)),
    [databasePath, endpoint, "pending"],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exit = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
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
  assert.equal(
    (await scheduler.listExecutions()).records.find((record) => record.id === pending.id).status,
    "submitted",
  );
});

test("a process interruption after host acceptance recovers with the identical executionId", async (t) => {
  const path = await directory("dispatch-recovery");
  const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 1_000 });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(5_000) });
  const child = fork(
    fileURLToPath(new URL("./fixtures/crash-scheduler.mjs", import.meta.url)),
    [databasePath, endpoint],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exit = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
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

test(
  "an actual HTTP acknowledgement timeout leaves dispatching and recovers the accepted task",
  { timeout: 10_000 },
  async (t) => {
    const path = await directory("http-timeout");
    const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
    const endpoint = await host.listen();
    t.after(() => host.close());
    const databasePath = join(path, "scheduler.sqlite");
    const scheduler = await Scheduler.open({
      store: await SqliteSchedulerStore.open(databasePath),
      dispatcher: new HttpTaskDispatcher(endpoint, { signal: acknowledgementTimeout(t, host) }),
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
  },
);

test("a real storage failure stops the timer and reports the error to the host", async (t) => {
  const reported = [];
  const { scheduler, host, store } = await setup(t, "storage-failure", {
    onError(error) {
      reported.push(error);
    },
  });
  await scheduler.createJob(
    job("storage-failure", {
      type: "at",
      time: new Date(Date.now() + 80).toISOString(),
    }),
  );
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

test(
  "a service-mode event communication error stops timers until explicit recovery",
  { timeout: 10_000 },
  async (t) => {
    const path = await directory("service-transport-error");
    const host = await DurableTaskHost.open(join(path, "host"), { acknowledgementDelayMs: 150 });
    const endpoint = await host.listen();
    t.after(() => host.close());
    const reported = [];
    const dispatcher = new HttpTaskDispatcher(endpoint, { signal: acknowledgementTimeout(t, host) });
    const scheduler = await Scheduler.open({
      store: await SqliteSchedulerStore.open(join(path, "scheduler.sqlite")),
      dispatcher,
      onError(error) {
        reported.push(error);
      },
    });
    t.after(() => scheduler.close());
    await scheduler.createJob(job("event-error", { type: "event", topic: "tasks" }));
    await scheduler.createJob(
      job("timer-after-error", { type: "at", time: new Date(Date.now() + 60_000).toISOString() }),
    );
    await scheduler.start();
    await assert.rejects(scheduler.publish(event("service-timeout")), { name: "TimeoutError" });
    assert.equal(reported.length, 1);
    assert.equal(reported[0].name, "TimeoutError");
    const acceptedId = host.tasks()[0].execution_id;
    const acceptedTaskId = host.tasks()[0].task_id;
    await assert.rejects(async () => scheduler.publish(event("service-stopped")));
    await scheduler.updateJob("timer-after-error", { trigger: { type: "at", time: new Date().toISOString() } }, 1);
    await delay(160);
    assert.equal(host.tasks().length, 1);
    assert.equal((await scheduler.listExecutions()).records.length, 1);
    dispatcher.signal = undefined;
    assert.equal((await scheduler.tick()).submitted, 2);
    const recovered = (await scheduler.listExecutions()).records.find((record) => record.id === acceptedId);
    assert.equal(recovered.status, "submitted");
    assert.equal(recovered.taskId, acceptedTaskId);
    assert.equal(host.tasks().length, 2);
    assert.equal(reported.length, 1);
  },
);

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
  const child = fork(
    fileURLToPath(new URL("./fixtures/failing-error-handler.mjs", import.meta.url)),
    [databasePath, endpoint, reportPath],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
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
  await writeFile(
    join(path, "failure-evidence.json"),
    `${JSON.stringify(
      {
        exitCode,
        signal,
        stdout,
        stderr,
        interrupted,
        recovered,
        taskArtifactPath: receipt.artifactPath,
      },
      null,
      2,
    )}\n`,
  );
});
