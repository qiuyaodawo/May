# Remote coordination workers

**English** | [简体中文](../../zh-CN/guides/coordination-remote.md)

`@may/coordination/remote` runs leaf tasks in independent Node.js worker
processes or hosts. One coordinator still owns the task graph, authorization,
dependencies, attempts and handoffs. Workers own their registered agents,
Sessions and a separate durable dispatch journal. This is not a multi-writer
scheduler or a high-availability ownership protocol.

## Embed a worker

The host supplies the model, tools and Session store through a normal
`CoordinationAgent`, usually `createApplicationAgent()`. Do not accept arbitrary
agent definitions, tools or model credentials from the coordinator's task input.

```ts
import { createServer } from "node:http";
import { CoordinationWorker } from "@may/coordination/remote";

// workerAgent is a host-configured CoordinationAgent with durable Session storage.
const worker = await CoordinationWorker.open({
  directory: "./worker-data/dispatches",
  token: process.env.MAY_WORKER_TOKEN!,
  agents: { analyst: workerAgent },
  authorize: ({ agent, execution }) =>
    agent === "analyst" && execution.coordinationId === "review-1",
  maxConcurrent: 2,
  maxJobs: 128,
});
const server = createServer(worker.handle);
server.listen(8787, "127.0.0.1");

// On shutdown: stop accepting requests, then await worker.close().
```

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

```ts
import { CoordinationRuntime } from "@may/coordination";
import { FileCoordinationStore } from "@may/coordination/file-store";
import { createRemoteAgent } from "@may/coordination/remote";

const remote = createRemoteAgent({
  url: "http://127.0.0.1:8787",
  token: process.env.MAY_WORKER_TOKEN!,
  agent: "analyst",
  version: workerAgent.version,
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
  // Inspect every task status; wait() also returns blocked states.
  console.log(snapshot.tasks.map(({ id, status }) => ({ id, status })));
} finally {
  await runtime.close();
}
```

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
