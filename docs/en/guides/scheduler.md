# Persistent time and event scheduling

**English** | [简体中文](../../zh-CN/guides/scheduler.md)

`@may/scheduler` persists trigger definitions and immutable execution records,
then submits tasks through a host-owned `TaskDispatcher`. Importing the package
and calling `Scheduler.open()` creates no timer and starts no Agent. Agent
configuration, Session selection, task execution, approvals and delivery belong
to the host. The public package remains a developer-preview API.

## Daily brief

```ts
import { Scheduler } from "@may/scheduler";
import { SqliteSchedulerStore } from "@may/scheduler/sqlite-store";

const scheduler = Scheduler.open({
  store: SqliteSchedulerStore.open("./data/scheduler.sqlite"),
  dispatcher: taskService,
  maxConcurrentSubmissions: 4,
  onError: error => console.error(error),
});

await scheduler.createJob({
  id: "daily-ai-brief", enabled: true,
  trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
  task: {
    handler: "ai-brief",
    payload: { agent: "researcher", prompt: "Summarize AI developments with source links." },
  },
  misfire: { policy: "latest", graceMs: 7_200_000 },
});
await scheduler.start();
// The host calls scheduler.close() during orderly shutdown.
```

`taskService.submit(request)` must durably accept the task before returning
`{ taskId }`. Repeated calls with the same `executionId` must return the same
task identity without repeating Agent work. The host can enqueue work, launch an
Agent on its own worker, and publish the result separately. Compute a brief's
reporting window from `request.scheduledAt`, so a late start preserves its scope.

The scheduler persists `dispatching` before invoking the dispatcher. It saves
`submitted` and `taskId` after the host acknowledges acceptance. A crash between
these operations is recovered by submitting the same identity on the next
`tick()` or `start()`. A host receipt alone proves task acceptance; Agent success
and delivery success have their own host records.

For system cron, systemd timers, or Windows Task Scheduler, open the store, call
`tick()`, then close it. A service can instead call `start()` and keep the process
online. The two modes are mutually exclusive on one Scheduler. May does not
register a system service or start applications automatically.

## Rules and edits

`at` requires an ISO timestamp with `Z` or an explicit numeric UTC offset. `cron`
requires five fields and an IANA timezone. `cron-parser` handles expression
parsing; randomized `H` fields and predefined aliases are rejected. A nonexistent
local time during a daylight-saving transition is skipped. A repeated local
minute triggers once, at its first occurrence. `event` subscribes to an exact
topic. The host validates webhooks and publishers before calling `publish()`.

Job IDs, handlers, event sources, event IDs and topics contain 1–256 characters
without control characters. Topics also contain non-whitespace text. Event
timestamps contain a date and time as well as an explicit UTC offset.

Create and update validate inputs immediately. Jobs have monotonic `revision`
values. `updateJob(id, changes, expectedRevision)` and
`deleteJob(id, expectedRevision)` reject stale revisions. Each execution retains
its accepted job snapshot. Pausing or deleting a job does not cancel already
accepted work. Re-enabling a job computes time occurrences from the enabling
time. Deleted IDs remain reserved, protecting old identities and deduplication.

`task.payload` and event payloads are finite JSON values. Timestamps are strings;
sequence cursors and revisions are safe integers. Task and event payloads are
limited to 64 KiB and 60 levels of nesting. Each stored JSON value is limited to
1 MiB and 64 levels of nesting. Credentials belong in host services; persist
configuration references in payloads.

## Late starts

`graceMs` is the allowed delay for a due occurrence. An occurrence processed
within that window is eligible under both policies. If the earliest due time is
older than that window:

- `skip` records the missed interval without submitting it;
- `latest` selects only the most recent due time, submits it when it is within
  the window, and records older missed occurrences as skipped.

For the example, a restart at 09:00 submits the 08:00 task; a restart at 11:00
skips it. Years of missed cron times are summarized in bounded skipped records,
with the skipped interval described in `detail`, rather than creating every old
task. One-shot times can be created in the past and follow the same rules.

## Events

```ts
const records = await scheduler.publish({
  source: "github", id: "delivery-123", topic: "issue.opened",
  occurredAt: "2026-10-04T10:00:00+08:00",
  payload: { repository: "example/project", issue: 123 },
});
```

An event and all matching job execution snapshots are accepted in one
transaction. A repeated `source` and `id` returns the original matches. Different
content with the same identity fails. Object key order does not change JSON
identity. Jobs added or edited after acceptance do not receive that old event.
`publish()` submits the accepted records and returns their current states.
Opening is sufficient for explicit event publishing; timers remain opt-in.

## Lifecycle and failures

`start()` requires an `onError` callback and starts an internal wakeup loop.
Background failure stops the loop and reports the error. `tick()` failures
reject its Promise. An exception from the background `onError` callback is
re-thrown as an uncaught error. `TaskRejectedError` records `failed` only when the host can
prove that it did not accept the task. Other submission failures preserve
`dispatching`; retrying a tick preserves identity. Storage failures stop further
work and require reopening the Scheduler.

`stop()` immediately prevents new event acceptance and waits for admitted
operations and submissions to settle. A later `tick()` or `start()` explicitly
reactivates acceptance. `close()` stops, drains, and releases storage; repeated
close calls are safe. Dispatchers must settle their Promises: the scheduler
does not infer acceptance from a timeout and does not cancel host Agent work.

`maxConcurrentSubmissions` bounds dispatcher calls, not Agent execution. The
host manages its execution concurrency, Run budgets and Session serialization.
`listExecutions({ jobId?, status?, afterSeq?, limit? })` returns stable ascending
sequence pages, with a default limit of 100 and a maximum of 1,000.

## Storage and deployment

`SchedulerStore` exposes synchronous `get`, `list`, `put`, `delete`, `transaction`
and `close`. Transactions must commit or abort together and must not return a
Promise. The store has exclusive ownership for the open Scheduler's lifetime.

The SQLite adapter uses `node:sqlite`, schema identity/version checks, WAL and
FULL synchronization. A companion SQLite database holds an exclusive transaction
for host ownership. SQLite releases that lock when the process ends, allowing
restart recovery; the companion database files remain part of the store.
Another active host fails immediately. Keep files on a local filesystem with
working SQLite file locks. Do not remove the companion files while a host runs.
The store contains plaintext task and event data. Use host access controls and
retain backups. Execution, event deduplication and deleted-ID records are retained;
storage retention and archival are host operational responsibilities.

There is no dependency from Core, Session or Application to this component.
The release package list for this change is `@may/scheduler`, version `0.1.0`
with a minor feature changeset. Runtime dependencies are `cron-parser` and
`luxon`; version preparation and publication require separate user instructions.

## Verification

```powershell
pnpm --filter @may/scheduler test
pnpm --filter @may/scheduler test:live
pnpm test:package:scheduler
pnpm test:integration:scheduler
pnpm docs:check
```

Tests use real SQLite, real host task receipts, actual artifact handlers and child
process interruption. `test:live` records an exact start timestamp and schedules
one task at that timestamp plus 60,000 ms. It reports planned and observed times,
delay, execution identity, task identity and the resulting artifact. Output lives
under the ignored `scheduler-verification/` directory. This offline task-host
check validates scheduling and acceptance independently of model or news access.

`test:integration:scheduler` uses the host's configured default model and makes
one real May Agent call. It schedules a task exactly 60,000 ms after its recorded
start, collects public GitHub release data from `vllm-project/vllm` and
`huggingface/transformers` for the preceding 24 hours, and writes `brief.md`,
`notification.json` and `report.json`. An empty source window is reported
explicitly. This bounded source selection verifies the scheduling-to-Agent path;
a production news handler supplies its own broader source coverage and delivery.
The notification artifact is stored locally. This command requires network access
and a valid model configuration and uses the configured provider's quota.
