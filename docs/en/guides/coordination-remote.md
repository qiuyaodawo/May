# Remote coordination workers

**English** | [简体中文](../../zh-CN/guides/coordination-remote.md)

Use `@may/coordination/remote` to execute leaf tasks in a separate Node.js
process or host. The coordinator owns the graph, authorization, dependencies,
attempts and handoffs. Each worker owns its registered agents, Sessions and
durable dispatch journal.

This guide assumes a [configured coordination Agent](coordination.md) with
durable Session storage. The worker host needs its own provider credentials,
allowed inputs and tools. Install or link `@may/coordination` in both hosts,
and arrange HTTPS for connections between machines.

## Embed a worker

1. Create a host-configured `CoordinationAgent`, usually with
   `createApplicationAgent()`, using its own model, tools and durable Session
   store. The snippet assumes this object is named `workerAgent`.
2. Set `MAY_WORKER_TOKEN` in both host environments to the same randomly generated
   secret containing at least 24 non-whitespace characters. Keep it outside
   source control and model inputs.
3. Open the dispatch journal and listen on loopback. This host fragment registers
   `analyst` and accepts only tasks for coordination `review-1`:

```ts
import { createServer } from "node:http";
import { CoordinationWorker } from "@may/coordination/remote";

const token = process.env.MAY_WORKER_TOKEN;
if (!token) throw new Error("MAY_WORKER_TOKEN is required");
const worker = await CoordinationWorker.open({
  directory: "./worker-data/dispatches",
  token,
  agents: { analyst: workerAgent },
  authorize: ({ agent, execution }) =>
    agent === "analyst" && execution.coordinationId === "review-1",
  maxConcurrent: 2,
  maxJobs: 128,
});
const server = createServer(worker.handle);
server.listen(8787, "127.0.0.1");

```

Keep the process running while it serves requests. During shutdown, stop
accepting HTTP requests with `server.close()` and await `worker.close()` before
releasing worker resources.

Use a randomly generated bearer secret of at least 24 non-whitespace characters,
kept outside prompts and source control. Plain HTTP is accepted only on loopback;
use an HTTPS server for connections from other hosts. An origin URL without a
path, query, user info or fragment is required by the client. Redirects and
browser Origin requests are rejected; no CORS interface is provided.

Worker authorization is independent of coordinator policy and is checked at
acceptance and again before execution. The worker registry pins agent versions.
Keep the same registered versions available when reopening its journal.
Cancellation still requires authentication and a matching dispatch, but remains
available after execution authorization is revoked.

## Register the remote agent

In the coordinator process, use the same secret, the worker's registered Agent
name and its exact `version`. The snippet assumes the worker uses version
`analysis-v1`; replace it if your `workerAgent.version` differs. Use a new graph
ID, or call `resume()` for an existing graph.

```ts
import { CoordinationRuntime } from "@may/coordination";
import { FileCoordinationStore } from "@may/coordination/file-store";
import { createRemoteAgent } from "@may/coordination/remote";

const token = process.env.MAY_WORKER_TOKEN;
if (!token) throw new Error("MAY_WORKER_TOKEN is required");
const remote = createRemoteAgent({
  url: "http://127.0.0.1:8787",
  token,
  agent: "analyst",
  version: "analysis-v1",
});
const runtime = await CoordinationRuntime.create({
  id: "review-1",
  store: new FileCoordinationStore("./coordinator-data"),
  policy: { version: "review-policy-v1", authorize: (task) => task.agent === "remote" },
  agents: { remote },
  tasks: [{ id: "review", agent: "remote", input: "Review the explicitly supplied material." }],
});
try {
  const snapshot = await runtime.wait();
  // 检查各任务状态，确认任务是否完成或需要恢复。
  console.log(snapshot.tasks.map(({ id, status }) => ({ id, status })));
} finally {
  await runtime.close();
}
```

Completion requires the `review` task to be `completed` with a durable output.
If it is `recovery-required`, inspect the worker and Session evidence using the
recovery rules below.

The coordinator sends the explicit task input, dependency answers and supplied
mailbox/wakeup data, not model reasoning, provider credentials or full Session
history. Only trusted worker hosts should receive this data. Live non-streaming
events and active approval decisions are relayed; event buffers are bounded and
not replayed after a worker restart. Durable Session evidence remains authoritative.

## Recovery and cancellation

The worker fsyncs dispatch acceptance and running state before calling an agent.
A dispatch is identified by coordination, task, dispatch id and turn. Repeated
requests with the same identity are idempotent; conflicting payloads are rejected.
If an acceptance response is lost, the client does not resend execution blindly.
`recover()` inspects evidence; active or accepted queued work is
`recovery-required`, never `not-started`. Reopen/resume after the worker settles
to recover its durable result. Unknown external effects need host reconciliation.

Cancellation persists intent before aborting execution. A full-dispatch cancel
can create a tombstone before a delayed acceptance arrives, preventing that
request from starting work. The coordinator also sends cancellation for inactive
remote work whose acceptance is uncertain. Network failure still leaves an
unknown outcome; cancellation is not a rollback or proof that effects stopped.
Workers retain an Agent's optional idempotent `cancel(execution)` control and
deliver it to detached executions after saving cancellation intent. Recovery
receives `execution.task.cancelRequested`; reopening the worker, querying recovery,
and closing the worker retry saved cancellation intents that remain uncertain.
An unconfirmed control delivery remains `recovery-required`. Cancellation acceptance
confirms the saved request; durable Agent evidence determines the final outcome.
Late durable results remain evidence rather than being silently discarded.
`runtime.close()` also requests cancellation for detached uncertain remote work
before releasing coordinator ownership; closing is not a background-run command.

Opening a worker only reconciles existing Session evidence. It never starts
models or tools. Queued work after restart needs an explicit matching acceptance
request before execution. Journals use exclusive locks, ordered fsynced records,
and bounded sizes (64 MiB by default). Only an incomplete final record is repaired;
corrupt complete records fail closed. After a crash, verify the old process has
stopped before manually removing its stale lock. Preserve both worker and Session
storage; do not delete evidence to force a retry.

## Scope

Worker defaults are 4 concurrent jobs, 1,024 retained jobs, 1 MiB per request and
64 MiB per journal. Set `maxConcurrent`, `maxJobs`, `maxRequestBytes` and
`maxJournalBytes` when opening the worker to change those positive limits.

- Remote workers are leaf executors. No remote capability RPC for delegation,
  peer messaging or handoff is exposed; keep orchestration on the coordinator.
- Files, artifacts and workspace copies are not automatically transferred. Each
  worker host must provision its own allowed inputs, tools and resource policy.
- The [shared budget](coordination-resources.md) is a local single-writer ledger,
  not a distributed global quota service. A remote deployment needs explicit
  host budget allocation; coordinator transport alone does not meter provider calls.
- There is no automatic lease takeover, worker discovery, load-balancing service,
  TLS certificate management, secret rotation or automatic effect rollback.
- The [MaybeCode team command](maybecode-team.md) uses local agents and defaults
  to read-only. Explicit coding mode edits private copies; applying source changes
  needs a separately reviewed patch and host confirmation, never an automatic
  merge. Configured checks and confirmed retry/reconciliation controls are local
  CLI features. Remote worker hosting and graph mutation remain host APIs, not
  remote-worker CLI flags or model tools; no multi-agent TUI is provided.
