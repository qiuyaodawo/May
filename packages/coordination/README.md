# @may/coordination

Developer-preview coordination above `@may/application`. One durable coordinator
owns pipelines, DAGs, parallel reduction, delegation, peer messaging and handoffs.
Execution can use local agents or independent remote leaf workers; this is not a
high-availability or multi-writer scheduler.

Root exports:

- `CoordinationRuntime.create()` / `.resume()`: exclusively open a coordination;
- `start()`, `wait()`, `snapshot()`, `events`, `cancel()`, `resolveApproval()`,
  `resolveRecovery()`, `retryTask()`, `rewriteGraph()` and `close()` on the runtime;
- `createApplicationAgent()`: adapt an `AgentDefinition` or per-turn definition
  factory and Session store; opt into `delegate_tasks` with `delegation: true`,
  `send_message` / `wait_for_messages` with `messaging: true`,
  or `handoff_task` with `handoff: true`;
- `pipeline()` and `parallelTasks()`: construct ordinary task graphs;
- `InMemoryCoordinationStore` and the public contracts;
- `FileSharedBudget`: durable local model-call reservations/accounting;
- `FileArtifactStore`: immutable, scoped UTF-8 artifacts;
- `TaskWorkspaceManager`: filtered per-task file copies and read-only change manifests.

`FileCoordinationStore` is exported through `@may/coordination/file-store`.
`CoordinationWorker` and `createRemoteAgent` use `@may/coordination/remote`.

Opening does not execute agents. `wait()` starts scheduling and resolves when no
execution remains active, **including recovery-blocked graphs**. Always inspect
the returned statuses. A dependency must complete successfully before its consumer
runs; unrelated branches continue after a failure. Each task controller uses an independent
Session and at most one identified input/Run per turn. Delegation atomically creates
independent children and a wait condition. Core yields only after the full tool
step is settled and persisted, freeing the slot. The parent wakes in a new turn
with all child outcomes, including failures. No automatic model/tool retries are added
by coordination; injected providers may still have their own retry policies.

Task limits, concurrency and the coordination deadline are host-enforced.
`limits.runBudget` applies to each Run; it is not a shared token/cost allowance.
Delegation requires an explicit `authorizeDelegation` policy in addition to tool
permissions. Defaults limit nesting to 4 levels and each task to 16 turns.
Peer messages require `authorizeMessage`, also default-deny. Envelopes and command
receipts are committed atomically; sender identity is host-stamped. An immutable
inbox is reserved before each turn's dispatch. Sending does not interrupt a Run;
an explicit message wait yields its slot and wakes on pending mail. Acceptance
does not prove reading or successful processing. Defaults cap the entire graph at
1,024 messages, with 16,384 UTF-8 bytes of text per message. Empty mailboxes may
leave all tasks waiting; `wait()` returns this quiescent state, not success.

Handoff transfers one logical task to a different agent, preserving its id, graph
edges and ownership but creating fresh Session/dispatch identities. Only an
explicit summary, the original input and static dependency answers reach the new
controller; history and approvals are not inherited. A persisted intent plus a
safe source yield must precede activation. `authorizeHandoff` is default-deny and
rechecked at target dispatch, along with task and parent-delegation policies.
No active child/wait or pending mail may overlap a handoff. New messages to a
pending transfer are rejected. Defaults allow 4 handoffs per task and 16,384 UTF-8
bytes per summary; handoffs also consume the existing task turn allowance.

The host must supply a versioned authorization policy, safe agent configurations
and an execution isolation policy. Independent Contexts are not OS sandboxes.

Durable dispatch identities precede execution. On resume, the Application adapter
reads Session evidence and does not re-submit existing inputs. Unknown effects
require explicit host reconciliation. File journals use exclusive `.lock` files,
fsync before acknowledgement, and a default 64 MiB log-size limit. A crashed
writer's lock is never automatically stolen. Keep both coordination and Session
storage durable; see the guide for recovery steps and storage ownership.

Host-authorized retries create fresh attempts without replaying old Sessions.
Atomic graph edits apply only to never-submitted nodes, not active/uncertain work.
Shared budgets reserve and account locally at the provider boundary; they are not
a distributed global budget service or a hard external billing cap. Resource
copies are not process sandboxes and never merge back automatically. Remote leaf
workers own their local dispatch evidence and Session execution; the coordinator
remains the sole scheduler. No automatic coordinator failover is provided.

MaybeCode exposes a read-only `team run/resume/status/cancel` CLI with scoped file
inspection, isolated copies, shared local budgets and final artifacts. It does not
expose shell, source edits, MCP or a multi-agent TUI. Single-Agent behavior is
unchanged unless the host supplies `shouldYield`.

See the [English guide](../../docs/en/guides/coordination.md) or
[简体中文指南](../../docs/zh-CN/guides/coordination.md) for a complete example and
the supported recovery/control contract.

Further guides (English / 简体中文):

- [Resources](../../docs/en/guides/coordination-resources.md) / [共享资源](../../docs/zh-CN/guides/coordination-resources.md)
- [Attempts and graph revisions](../../docs/en/guides/coordination-lifecycle.md) / [Attempt 与任务图修订](../../docs/zh-CN/guides/coordination-lifecycle.md)
- [Remote workers](../../docs/en/guides/coordination-remote.md) / [远程 Worker](../../docs/zh-CN/guides/coordination-remote.md)
- [MaybeCode teams](../../docs/en/guides/maybecode-team.md) / [MaybeCode 团队任务](../../docs/zh-CN/guides/maybecode-team.md)
