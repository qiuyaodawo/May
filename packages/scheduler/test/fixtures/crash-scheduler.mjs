import { Scheduler } from "../../dist/index.js";
import { SqliteSchedulerStore } from "../../dist/sqlite-store.js";
import { HttpTaskDispatcher } from "./durable-host.mjs";

const [databasePath, endpoint, mode] = process.argv.slice(2);
const scheduler = await Scheduler.open({
  store: await SqliteSchedulerStore.open(databasePath),
  dispatcher: new HttpTaskDispatcher(endpoint),
  maxConcurrentSubmissions: mode === "pending" ? 1 : 4,
});
await scheduler.createJob({
  id: "process-interruption",
  enabled: true,
  trigger: { type: "event", topic: "crash-test" },
  task: { handler: "write-artifact", payload: { case: "process-interruption" } },
  misfire: { policy: "latest", graceMs: 60_000 },
});
if (mode === "pending") {
  await scheduler.createJob({
    id: "second-pending",
    enabled: true,
    trigger: { type: "event", topic: "crash-test" },
    task: { handler: "write-artifact", payload: { case: "pending-interruption" } },
    misfire: { policy: "latest", graceMs: 60_000 },
  });
}
await scheduler.publish({
  source: "crash-test",
  id: "accepted-once",
  topic: "crash-test",
  occurredAt: new Date().toISOString(),
  payload: { message: "durable acceptance" },
});
await scheduler.tick();
await scheduler.close();
