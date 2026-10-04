# `@may/scheduler`

Opt-in durable time and event triggers for host-owned tasks. `Scheduler.open()`
opens a host-provided store without starting timers or Agents. Hosts call `start()`
for a resident timer loop or `tick()` for an external system scheduler.

```ts
import { Scheduler } from "@may/scheduler";
import { SqliteSchedulerStore } from "@may/scheduler/sqlite-store";

const scheduler = Scheduler.open({
  store: SqliteSchedulerStore.open("./data/scheduler.sqlite"),
  dispatcher: taskService,
  onError: error => console.error(error),
});

await scheduler.createJob({
  id: "daily-ai-brief",
  enabled: true,
  trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
  task: { handler: "ai-brief", payload: { agent: "researcher" } },
  misfire: { policy: "latest", graceMs: 2 * 60 * 60 * 1000 },
});

await scheduler.start();
```

`taskService` implements `TaskDispatcher`: it durably accepts a task keyed by
`executionId` and returns the same `taskId` on repeated submissions. It owns Agent
configuration, execution, permissions, cancellation and delivery. `submitted`
means durable acceptance; query the host task service for Agent outcomes.

Read the [English guide](../../docs/en/guides/scheduler.md) or
[简体中文指南](../../docs/zh-CN/guides/scheduler.md) for lifecycle, event deduplication,
misfire rules, restart recovery, SQLite ownership and verification commands.

Node.js >=22.16.0 is required. Public entry points are `@may/scheduler` and
`@may/scheduler/sqlite-store`. The release package list for this component is
explicitly `@may/scheduler`; its runtime dependencies are `cron-parser` and
`luxon`. `pnpm test:package:scheduler` installs the packed package into a consumer
outside the repository and verifies those dependencies.
