import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Scheduler } from "../dist/index.js";
import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { DurableTaskHost } from "./fixtures/durable-host.mjs";

const verificationRoot = fileURLToPath(new URL("../../../scheduler-verification/", import.meta.url));
await mkdir(verificationRoot, { recursive: true });
const directory = await mkdtemp(join(verificationRoot, "live-timer-"));
const host = await DurableTaskHost.open(join(directory, "host"));
const scheduler = await Scheduler.open({
  store: await SqliteSchedulerStore.open(join(directory, "scheduler.sqlite")),
  dispatcher: host,
  onError(error) { throw error; },
});
const displayTime = (time) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "full",
  timeStyle: "long",
}).format(new Date(time));

try {
  const startedAt = new Date().toISOString();
  const scheduledAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  const accepted = once(host, "accepted", { signal: AbortSignal.timeout(75_000) });
  await scheduler.createJob({
    id: "one-minute-verification",
    enabled: true,
    trigger: { type: "at", time: scheduledAt },
    task: {
      handler: "write-artifact",
      payload: { verification: "real-time durable task dispatch", startedAt, scheduledAt },
    },
    misfire: { policy: "latest", graceMs: 15_000 },
  });
  console.log(JSON.stringify({
    phase: "scheduled",
    timezone: "Asia/Shanghai",
    startedAt,
    startedAtDisplay: displayTime(startedAt),
    scheduledAt,
    scheduledAtDisplay: displayTime(scheduledAt),
    intervalMs: Date.parse(scheduledAt) - Date.parse(startedAt),
    directory,
  }, null, 2));
  await scheduler.start();
  const [receipt] = await accepted;
  await scheduler.stop();
  const [execution] = (await scheduler.listExecutions()).records;
  const artifact = JSON.parse(await readFile(receipt.artifactPath, "utf8"));
  assert.equal(execution.status, "submitted");
  assert.equal(execution.taskId, receipt.taskId);
  assert.equal(execution.id, artifact.request.executionId);
  assert.equal(execution.scheduledAt, scheduledAt);
  assert.equal(host.tasks().length, 1);
  assert.ok(Date.parse(receipt.acceptedAt) >= Date.parse(scheduledAt));
  const report = {
    phase: "completed",
    timezone: "Asia/Shanghai",
    startedAt,
    scheduledAt,
    acceptedAt: receipt.acceptedAt,
    acceptedAtDisplay: displayTime(receipt.acceptedAt),
    timingDifferenceMs: Date.parse(receipt.acceptedAt) - Date.parse(scheduledAt),
    executionId: execution.id,
    taskId: receipt.taskId,
    status: execution.status,
    artifactPath: receipt.artifactPath,
    schedulerDatabasePath: join(directory, "scheduler.sqlite"),
    hostDatabasePath: join(directory, "host", "tasks.sqlite"),
    verificationScope: "Real timer, SQLite persistence, actual task handler and dispatch acknowledgement.",
  };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await scheduler.close();
  await host.close();
}
