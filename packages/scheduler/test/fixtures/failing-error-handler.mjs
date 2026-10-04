import { writeFileSync } from "node:fs";

import { Scheduler } from "../../dist/index.js";
import { SqliteSchedulerStore } from "../../dist/sqlite-store.js";
import { HttpTaskDispatcher } from "./durable-host.mjs";

const [databasePath, endpoint, reportPath] = process.argv.slice(2);
const scheduler = Scheduler.open({
  store: SqliteSchedulerStore.open(databasePath),
  dispatcher: new HttpTaskDispatcher(endpoint, { timeoutMs: 40 }),
  onError(error) {
    writeFileSync(reportPath, `${JSON.stringify({ message: error.message })}\n`);
  },
});
const scheduledAt = new Date(Date.now() + 100).toISOString();
await scheduler.createJob({
  id: "error-handler-termination",
  enabled: true,
  trigger: { type: "at", time: scheduledAt },
  task: { handler: "write-artifact", payload: { case: "error-handler-termination" } },
  misfire: { policy: "latest", graceMs: 60_000 },
});
await scheduler.start();
console.log(JSON.stringify({ phase: "scheduled", scheduledAt }));
