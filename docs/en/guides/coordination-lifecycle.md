# Attempts and graph revisions

**English** | [简体中文](../../zh-CN/guides/coordination-lifecycle.md)

The [coordination runtime](coordination.md) exposes two host-only lifecycle
operations: explicit new attempts and atomic edits of never-submitted graph nodes.
Neither operation is an automatic retry policy or an Agent tool. Both require
separate host authorization; omitting the policy callback denies the operation.

## Authorize a new attempt

```ts
const policy = {
  version: "team-policy-v2",
  authorize: (task) => task.agent === "analyst",
  authorizeRetry: (task, finding) =>
    ["failed", "cancelled"].includes(task.status) && finding.trim().length > 0,
};

// The host must actually verify this finding; this string is not verification.
await runtime.retryTask(
  "retry-analysis-1",
  "analysis",
  "The provider rejected the request before any tool effects; a new attempt is authorized.",
);
const snapshot = await runtime.wait();
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

The global task `turn` increases rather than resetting, so old mailbox receipts
remain unambiguous. `maxTaskTurns` (default 16), `maxHandoffs` (default 4), total
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

```ts
// Include this policy when creating/resuming the runtime.
const authorizeGraphRewrite = (change, snapshot) =>
  snapshot.tasks.length < 128 &&
  [...(change.add ?? []), ...(change.update ?? [])].every(
    (task) => task.agent === "analyst",
  );

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

These constraints intentionally exclude arbitrary rewriting of running workflows.
Use delegation, messages or handoff for active collaboration; use new tasks for
revised work that already has durable execution evidence.
