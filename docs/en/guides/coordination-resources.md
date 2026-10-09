# Shared resources for multi-agent tasks

**English** | [简体中文](../../zh-CN/guides/coordination-resources.md)

Use shared resources when a [coordination graph](coordination.md) needs a common
model allowance, explicit result files or separate task workspaces. The host opens
and owns each resource; Agent tool access still follows its configured permissions.

The TypeScript fragments below show host composition with `@may/coordination`.
They assume a configured provider `Model`, a graph ID and absolute resource
directories outside task tool roots. Bind the opened resources to your Agent
definitions before starting the graph, and close them after the runtime has stopped.

## Shared model budget

1. Select call and token limits for the complete graph, including later turns
   and attempts. Configure prices only when they match the selected provider.
2. Open one ledger and wrap every participating model at its physical request
   boundary. The fragment assumes `providerModel`, `budgetDirectory` and
   `coordinationId` are trusted host inputs:

```ts
import { FileSharedBudget } from "@may/coordination";

const budget = await FileSharedBudget.open(budgetDirectory, coordinationId, {
  maxModelCalls: 32,
  maxTotalTokens: 262_144,
  // 费用统计使用该 provider 和模型的明确价格。
  maxCostUsd: 2,
  tokenPrices: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
});
const meteredModel = budget.wrapModel(providerModel, {
  reservation: { totalTokens: 32_768, costUsd: 0.15 },
});
// 团队的 Agent definition 使用 meteredModel；所有 Run 停止后读取总计并关闭。
console.log(await budget.totals());
await budget.close();
```

3. Inspect `totals()` and `snapshot()` for settled, estimated and unknown calls.
   If new calls are blocked, verify provider receipts and reconcile the exact
   affected call before admitting more work.

`providerModel`, `budgetDirectory` and `coordinationId` are trusted host inputs.
The example prices are illustrative, not current provider prices. A reservation
is a host-selected upper estimate, not a provider token-setting API. Configure
provider output limits separately and size reservations for the largest expected
input plus output. Different providers/pricing require separate ledgers or a
host adapter with correct common accounting; one ledger has one fixed price table.

Before each model request, the wrapper durably reserves one call plus the declared
token/cost capacity. Concurrent reservations cannot spend the same remaining
capacity. Settlement uses provider-reported usage and releases the unused portion
**before** exposing `response.completed` to the Agent's tool step. Call identity is
May's stable `modelCallId`; an already reserved id is never automatically replayed.

The wrapper forwards optional `Model.preflight()` with the original Model as its
receiver. Execution validation does not reserve budget capacity; reservations
remain inside `stream()` when a provider request starts. The delegated request
budget wrapper follows the same rule. Both wrappers read Model metadata through
getters, so capability versions, configurations and limits reflect discovery and
refresh without recreating the budget wrapper.

- Put the budget wrapper at the **physical provider request boundary**, inside any
  retry wrapper, or disable hidden retries. A wrapper cannot count opaque inner
  attempts. Automatic retries using the same call identity are rejected, not free.
- Provider-native context compaction is deliberately not forwarded: its hidden
  call and missing usage would bypass accounting. Separately metered summarizers
  must use the same ledger if enabled by the host.
- Missing/invalid usage, an interrupted stream, or a reservation surviving a
  restart blocks new calls. A reservation overrun also blocks completion from
  reaching tools and blocks further calls.
- `reconcile(callId, verifiedUsage, evidence)` records host-verified accounting for
  unknown usage or an overrun. It does not call the provider, resume tools or change
  the Session's separate recovery decision. Already spent usage is never refunded
  merely because a task failed, yielded, handed off or was retried.
- A response-boundary guard cannot undo provider spending or stop requests already
  in flight. These are durable admission/accounting limits, **not a hard external
  billing cap**. The host must select sound reservations and provider limits.

`snapshot()` returns call receipts; `totals()` includes outstanding reservations.
`totals().usageComplete` is `true` only when every call settled with
provider-reported usage; a call charged by its reservation is marked `estimated` in
the snapshot and makes the total incomplete.

A host that cannot route a call through `wrapModel` accounts it directly:
`reserveCall(id, reservation)` before the request, then `settleCall(id, usage)` or
`markCallUnknown(id)`. `runExternal(id, reservation, operation)` does all three
around a host operation that is not a Model call, such as provider-native
compaction: a result carrying `usage` settles with it, and a result without usage
settles with the reservation as an estimate. A failed operation stays unknown. Every
id must be unique per call, and a call that was already reserved is never replayed.
The original per-Run budget remains independent and can further restrict each Run.
Limits and prices must match when reopening a ledger. Stop active model calls before
`close()`; ownership locks are never stolen automatically.

`settleCall(id, usage, preparedCost?)` accepts a validated `UsageCost` already
computed by the same pricing pipeline. It stores that receipt without invoking
a custom pricer again. The receipt must remain consistent with the ledger's
configured schedule and USD requirements.

An invalid completed response can throw `ModelResponseValidationError` carrying
known `usage` and `responseCompleted: true`. Both budget wrappers settle that
usage once and keep the rejection. A priced ledger forwards its stored `cost`
on the error for outer Run accounting; an unpriced ledger leaves the host's
pricing available. A call already settled remains settled. Missing usage remains
unknown, and the completed response must not be retried. If accounting also
fails, the error's cause preserves both the response rejection and accounting
failure.

Shared budgets also accept the versioned `pricing` schedule described in
[Run budgets](run-budgets.md). `FileSharedBudget.open(..., { usagePricer })` accepts
the same custom pricing callback as `RunBudget`; provide it again when reopening
or inspecting a ledger. Each settled call stores `cost`, including its amount,
currency, estimate/provider kind, price version and completeness. `costComplete`
is reported separately from token completeness. USD limits require complete USD
accounting. Unknown prices keep a call unresolved, requiring host reconciliation.
When the ledger has prices, a custom pricer or provider-reported amounts,
`wrapModel()` forwards its stored result on `response.completed.cost`, so Run
accounting and telemetry reuse it without calling a custom pricer again.
`runExternal()` without provider usage charges its token/cost reservation and
preserves an incomplete estimate. Changing price versions requires a new ledger.

## Immutable artifacts

Open an artifact store with a versioned read policy. The fragment assumes
`artifactDirectory` and `coordinationId` are host inputs and that the graph
contains `worker` and `manager`. Bind `forTask(taskId).tools()` only to the
corresponding task. Publication and explicit reading are shown here:

```ts
import { FileArtifactStore } from "@may/coordination";

const artifacts = await FileArtifactStore.open(artifactDirectory, coordinationId, {
  policyVersion: "review-team-v1",
  authorizeRead: (requester, artifact) =>
    requester === "manager" && artifact.ownerTaskId === "worker",
});
const workerArtifacts = artifacts.forTask("worker");
const reference = await workerArtifacts.publish("dispatch-1:turn-0:final", {
  name: "analysis.md",
  mimeType: "text/markdown",
  text: "An explicit task result, without hidden reasoning or credentials.",
});
const result = await artifacts.forTask("manager").read(reference.id);
// 可以在 worker 的 Agent definition 中加入 workerArtifacts.tools()。
await artifacts.close();
```

Artifacts contain bounded UTF-8 text and immutable metadata: id, owner, name, MIME
type, byte size and SHA-256. IDs and storage paths are host-generated; names are
display metadata. Each task can read its own artifacts. Reading another task's
artifact is denied unless the host ACL returns `true`; knowing an id is not a grant.

`publish_artifact` and `read_artifact` use a task binding supplied by the host, not a
model-controlled owner. A durable command can be acknowledged again only with the
same content. Publication writes and syncs an immutable blob before acknowledging
its journal record. Reads check size, file type and hash. Changed bytes or links are
rejected; a partially written/unreferenced blob is not silently replaced.

Defaults: 256 artifacts, 1 MiB per artifact, 16 MiB total. Limits and ACL version must
match on reopen. `snapshot()` exposes references to the host. Models use
task-bound tools, and reads must pass the ACL. Use a distinct command id per dispatch/turn output.
Send explicit artifact ids in task messages or answers; content is not automatically
injected into every Agent's context. Treat artifact content as untrusted task data.

## Task workspace copies

Choose a source checkout and a private resource directory with no overlap.
The fragment assumes `userCheckout`, `privateTeamDirectory` and an existing
`task` specification. Prepare the task copy, bind its file tools and inspect
changes when its execution has stopped:

```ts
import { TaskWorkspaceManager } from "@may/coordination";

const workspaces = await TaskWorkspaceManager.open({
  sourceDirectory: userCheckout,
  directory: privateTeamDirectory,
});
const workspace = await workspaces.prepare(task.id);
// 将本任务的文件工具绑定到 workspace.directory。
const changes = await workspaces.changes(task.id);
// 展示 changes 供审查；选定修改由宿主单独应用。
await workspaces.close();
```

The manager first snapshots a filtered team baseline, then creates an independent
regular-file copy for each logical task. All tasks start from the same baseline,
even if the source later changes. Turns, handoffs and explicit retries of that
task retain its copy; there is no automatic rollback. The user's checkout is never
modified. There is no automatic Git operation, merge, deletion or write-back.

Repeated `prepare(task.id)` calls validate the existing task directory and return
its workspace without appending a journal record. Concurrent calls are serialized.

Defaults: 10,000 files, 64 MiB in one snapshot, 128 task copies. All hidden basenames,
dependency/build/cache/data directories, common credential basenames and key/certificate
files are excluded. `excludeNames` adds exclusions but does not remove the built-ins.
Symbolic links/junctions and non-regular files are skipped. This is a conservative
name filter, **not secret detection**: inspect any input repository before giving
Agents access to its copied ordinary files. Executable permission metadata and
dependencies are not preserved; this is not a ready-to-build environment image.

`changes()` reports bounded added/modified/deleted regular files and hashes for
review. The host must explicitly review and apply selected changes elsewhere; the
manager has no merge API. Interrupted initial/task copies stay quarantined instead
of being silently replaced. Inspect their private directories before manual cleanup.

File-copy isolation is **not a process sandbox**. It does not prevent a shell,
network client or unrestricted tool from accessing other paths or credentials.
Keep baseline/resource storage outside task tool roots; use scoped read/write tools,
explicit permissions and a real OS/container sandbox when executing untrusted code.

## Persistence and ownership

Close resources in dependency order:

1. Await `runtime.close()` so model calls, tool calls and state changes settle.
2. Read the final usage, artifact references and workspace changes needed for review.
3. Await the budget, artifact store and workspace manager's `close()` methods.
4. Retain their journals and private copies according to the host's data policy.

Each store is a single-writer local journal with synced acknowledgements. A partial
last JSONL record can be repaired; complete corruption, changed configuration and
ambiguous writes fail closed. Do not remove locks while an owner may still be live.
These files do not implement distributed locking or automatic stale-lock recovery.
Close the coordination runtime and await its active work before closing resources.
