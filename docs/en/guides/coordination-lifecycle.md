# Attempts and graph revisions

**English** | [简体中文](../../zh-CN/guides/coordination-lifecycle.md)

Use `retryTask()` to authorize another attempt after inspecting a failed task.
Use `rewriteGraph()` to change future work before its inputs have been submitted.
Both operations belong to the host and require an explicit policy callback.

This guide assumes an existing [coordination runtime](coordination.md), its
durable Session records and access to external task evidence. Configure the
callbacks when creating the graph, and provide the same policy version on resume.

## Authorize a new attempt

1. Include `authorizeRetry` in the policy passed to `CoordinationRuntime.create()`
   or `resume()`. This typed policy permits retries for the `analyst` role after
   the host has recorded a finding:

```ts
import type { CoordinationPolicy } from "@may/coordination";

const policy: CoordinationPolicy = {
  version: "team-policy-v2",
  authorize: (task) => task.agent === "analyst",
  authorizeRetry: (task, finding) =>
    ["failed", "cancelled"].includes(task.status) && finding.trim().length > 0,
};
```

2. Inspect the task, its owned descendants and external effects. If its state is
   `recovery-required`, call `resolveRecovery()` with verified evidence before
   requesting a retry.
3. Call `retryTask()` with a unique command ID and the actual finding, then
   inspect the new attempt's status after `wait()`:

```ts
await runtime.retryTask(
  "retry-analysis-1",
  "analysis",
  "The provider rejected the request before any tool effects; a new attempt is authorized.",
);
const snapshot = await runtime.wait();
console.log(snapshot.tasks.find((task) => task.id === "analysis"));
```

`retryTask(commandId, taskId, finding)` accepts only a known `failed` or
`cancelled` task. A `recovery-required` task must first be reconciled with
`resolveRecovery()` using verified evidence. Reconciliation records the finding;
it does not execute anything. The retry policy is checked again before dispatch.

A retry retains the logical task id, input, static dependencies and parent. It
allocates a fresh Session and dispatch id, increments `attempt` (initially zero),
and appends an immutable prior terminal task snapshot to `attempts`. Each entry
contains the accepted command id, host finding and old controller/handoff/output
evidence. Old Session histories are never changed or resubmitted. The new Session
receives the original task, explicit dependency results, and a marked diagnostic
summary, not the old conversation or tool approvals.

The global task `turn` continues increasing from its previous count, so old
mailbox receipts retain their turn identities. `maxTaskTurns` (default 16), `maxHandoffs` (default 4), total
tasks, messages and the coordination deadline remain lifetime limits. `maxAttempts`
(default 3) includes the initial attempt. A new attempt does not roll back files,
remote side effects or usage; shared budgets continue charging new calls.

Retry is refused when:

- The task or one of its owned descendants is still active or has an unknown outcome.
- A parent already reserved this child's result, or a static consumer has submitted work.
- Undelivered messages would cross into the new attempt.
- A delegated task's parent is no longer waiting.
- The coordination is stopped, expired or has no remaining turn/attempt allowance.

Retrying an upstream task does not retry its dependants. A dependant failed solely
because of an upstream failure may be retried separately after upstream succeeds;
this is another explicit, authorized command. Completed tasks are never retried.

Reusing an accepted command id with the same finding is a no-op; changing its
payload is rejected. If a retry commit was acknowledged ambiguously, close and
resume the runtime. Durable state identifies the new attempt; the old one is not
replayed. Existing worker/agent versions must remain registered for retained
historical controllers when resuming.

Detached adapters may implement `cancel(execution)` for externally owned work.
The coordinator persists cancellation intent before sending this idempotent control
request, including parent cascades, deadlines and runtime close. Failure to deliver
cancellation remains `recovery-required`; an acknowledgement alone is not proof of
the execution outcome. Repeating the host cancellation command can retry delivery,
but never executes the task again.

## Atomically revise future graph nodes

1. Include `authorizeGraphRewrite` in the runtime policy at creation. The
   snippet uses the `CoordinationPolicy` import from above:

```ts
const authorizeGraphRewrite: NonNullable<CoordinationPolicy["authorizeGraphRewrite"]> = (change, snapshot) =>
  snapshot.tasks.length < 128 &&
  [...(change.add ?? []), ...(change.update ?? [])].every(
    (task) => task.agent === "analyst",
  );
const graphPolicy: CoordinationPolicy = { ...policy, authorizeGraphRewrite };
```

Pass `graphPolicy` as the runtime's `policy` option.

2. Identify queued top-level nodes whose inputs have never been submitted.
   This example assumes `first`, `summary` and `unused-check` already exist,
   and `summary` and `unused-check` are still eligible for editing.
3. Submit the complete change with a unique command ID:

```ts
await runtime.rewriteGraph("expand-plan-1", {
  add: [
    { id: "second-check", agent: "analyst", input: "Check the first result.", dependsOn: ["first"] },
  ],
  update: [
    { id: "summary", agent: "analyst", input: "Summarize both checks.", dependsOn: ["first", "second-check"] },
  ],
  remove: ["unused-check"],
});
```

`TaskGraphChange` accepts `add`, `update` and `remove` arrays. An update is a full
`TaskSpec`, not a partial patch. No task id may appear twice in a single edit.
All changed nodes, dependencies, cycles, quotas and the resulting whole graph
are checked before a single durable commit. General task authorization is also
required for every added or changed node and is rechecked at dispatch.

Only pristine, queued, top-level nodes can be updated or removed. They must never
have submitted an input, reserved an inbox, participated in delegation, owned
children, waited, handed off or retried. Read-only adapter recovery must establish
`not-started`, and mailbox/ownership/wakeup references prevent editing. Executing,
waiting, terminal and uncertain work is immutable. To change a plan after work has
started, add new nodes depending on existing completed results and edit only the
remaining pristine nodes.

Replaced nodes get fresh Session/dispatch identities. `graphChanges` records each
accepted change and full prior node snapshots. Removed ids are tombstones: neither
graph edits nor delegated tasks may reuse them. The lifetime `maxTasks` quota counts
removed nodes as well as current ones. `maxGraphChanges` defaults to 32, with every
edit bounded by `maxTasks`. Graph edits do not reset deadlines or budgets.

After the command returns, inspect `runtime.snapshot().graphChanges` and the
new task specifications. Start or continue the scheduler to execute eligible
queued nodes. Use new task IDs for revised work that already has execution evidence.
