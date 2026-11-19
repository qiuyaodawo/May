import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { until } from "@sortedyuan/test-support";

import { Scheduler } from "../dist/index.js";
import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { DurableTaskHost, HttpTaskDispatcher } from "./fixtures/durable-host.mjs";
import { directory, event, job, setup } from "./fixtures/scheduler-setup.mjs";

function forkScheduler(t, fixture, args) {
  const child = fork(fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), args, {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = once(child, "close");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, exit, output: () => output };
}

async function acceptedBeforeExit(host, scheduler) {
  const result = await Promise.race([
    once(host, "accepted").then(([receipt]) => ({ receipt })),
    scheduler.exit.then(([code, signal]) => ({ code, signal })),
  ]);
  if (result.receipt === undefined) {
    assert.fail(
      `The scheduler process exited (${result.code ?? result.signal}) before the host accepted a task:\n${scheduler.output()}`,
    );
  }
  return result.receipt;
}

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

test("pending records survive a real scheduler process interruption", { timeout: 60_000 }, async (t) => {
  const path = await directory("pending-recovery");
  const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const crashing = forkScheduler(t, "crash-scheduler.mjs", [databasePath, endpoint, "pending"]);
  await acceptedBeforeExit(host, crashing);
  crashing.child.kill("SIGKILL");
  await crashing.exit;
  host.releaseAcknowledgements();
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(databasePath),
    dispatcher: host,
  });
  t.after(() => scheduler.close());
  const pending = (await scheduler.listExecutions()).records.find((record) => record.status === "pending");
  assert.ok(pending, crashing.output());
  assert.equal(pending.status, "pending");
  assert.equal((await scheduler.tick()).submitted, 2);
  assert.equal(host.tasks().length, 2);
  assert.equal(
    (await scheduler.listExecutions()).records.find((record) => record.id === pending.id).status,
    "submitted",
  );
});

test("recovery reuses the executionId after host acceptance", { timeout: 60_000 }, async (t) => {
  const path = await directory("dispatch-recovery");
  const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const crashing = forkScheduler(t, "crash-scheduler.mjs", [databasePath, endpoint]);
  const receipt = await acceptedBeforeExit(host, crashing);
  crashing.child.kill("SIGKILL");
  await crashing.exit;
  host.releaseAcknowledgements();
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
    const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
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
    host.releaseAcknowledgements();
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

test("a real storage failure stops the timer and reports the error to the host", { timeout: 60_000 }, async (t) => {
  const reported = [];
  const { scheduler, host, store } = await setup(t, "storage-failure", {
    onError(error) {
      reported.push(error);
    },
  });
  await scheduler.start();
  await scheduler.createJob(
    job("storage-failure", {
      type: "at",
      time: new Date(Date.now() + 80).toISOString(),
    }),
  );
  store.close();
  await until(t, () => reported.length > 0);
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
    const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
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
    host.releaseAcknowledgements();
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

test("an error callback restarts the scheduler and resumes its timers", { timeout: 60_000 }, async (t) => {
  const path = await directory("callback-restart");
  const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const dispatcher = new HttpTaskDispatcher(endpoint, { signal: acknowledgementTimeout(t, host) });
  const reported = [];
  let restarting;
  const scheduler = await Scheduler.open({
    store: await SqliteSchedulerStore.open(join(path, "scheduler.sqlite")),
    dispatcher,
    onError(error) {
      reported.push(error);
      host.releaseAcknowledgements();
      dispatcher.signal = undefined;
      restarting = scheduler.start();
    },
  });
  t.after(() => scheduler.close());
  await scheduler.start();
  const recoveringAt = new Date().toISOString();
  await scheduler.createJob(job("timer-recovery", { type: "at", time: recoveringAt }));
  await until(t, () => restarting !== undefined);
  await restarting;
  const followingAt = new Date().toISOString();
  await scheduler.createJob(job("timer-after-restart", { type: "at", time: followingAt }));
  await until(t, async () => {
    const records = (await scheduler.listExecutions()).records;
    return records.length === 2 && records.every((record) => record.status === "submitted");
  });
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

test("a failed error report terminates the child and allows recovery", { timeout: 60_000 }, async (t) => {
  const path = await directory("error-handler-termination");
  const host = await DurableTaskHost.open(join(path, "host"), { holdAcknowledgements: true });
  const endpoint = await host.listen();
  t.after(() => host.close());
  const databasePath = join(path, "scheduler.sqlite");
  const reportPath = join(path, "unwritable-report.json");
  await mkdir(reportPath);
  const failing = forkScheduler(t, "failing-error-handler.mjs", [databasePath, endpoint, reportPath]);
  const receipt = await acceptedBeforeExit(host, failing);
  host.closeConnections();
  const [exitCode, signal] = await failing.exit;
  host.releaseAcknowledgements();
  const output = failing.output();
  assert.equal(signal, null, output);
  assert.ok(exitCode > 0, output);
  assert.match(output, /(?:EISDIR|EPERM|EACCES)/u);
  assert.match(output, /unwritable-report\.json/u);
  assert.match(output, /failing-error-handler\.mjs/u);
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
        output,
        interrupted,
        recovered,
        taskArtifactPath: receipt.artifactPath,
      },
      null,
      2,
    )}\n`,
  );
});
