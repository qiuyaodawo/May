import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Scheduler } from "@may/scheduler";
import { SqliteSchedulerStore } from "@may/scheduler/sqlite-store";

const host = new DatabaseSync("tasks.sqlite");
host.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, artifact TEXT NOT NULL) STRICT");
const dispatcher = {
  async submit(request) {
    let row = host.prepare("SELECT artifact FROM tasks WHERE id = ?").get(request.executionId);
    if (!row) {
      const artifact = resolve(`${request.executionId}.json`);
      await writeFile(artifact, JSON.stringify(request), { flag: "wx" });
      host.prepare("INSERT INTO tasks (id, artifact) VALUES (?, ?)").run(request.executionId, artifact);
      row = { artifact };
    }
    assert.equal(JSON.parse(await readFile(row.artifact, "utf8")).executionId, request.executionId);
    return { taskId: request.executionId };
  }
};
const scheduler = Scheduler.open({ store: SqliteSchedulerStore.open("schedule.sqlite"), dispatcher });
try {
  await scheduler.createJob({
    id: "consumer-event", enabled: true,
    trigger: { type: "event", topic: "package-check" },
    task: { handler: "write-artifact", payload: { checked: true } },
    misfire: { policy: "latest", graceMs: 60_000 }
  });
  const event = { source: "consumer", id: "1", topic: "package-check", occurredAt: new Date().toISOString(), payload: null };
  const first = await scheduler.publish(event);
  const second = await scheduler.publish(event);
  assert.equal(first[0].status, "submitted");
  assert.equal(first[0].id, second[0].id);
  assert.equal(Number(host.prepare("SELECT COUNT(*) AS count FROM tasks").get().count), 1);
  const cron = await scheduler.createJob({
    id: "consumer-cron", enabled: true,
    trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
    task: { handler: "write-artifact", payload: null },
    misfire: { policy: "latest", graceMs: 60_000 }
  });
  assert.ok(cron.nextAt);
} finally {
  await scheduler.close();
  host.close();
}
console.log("External scheduler imports, SQLite store, cron calculation, event deduplication and artifact execution passed");
