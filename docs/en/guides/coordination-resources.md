# Shared resources for multi-agent tasks

**English** | [简体中文](../../zh-CN/guides/coordination-resources.md)

The [coordination runtime](coordination.md) manages task execution. Three optional
host-owned components manage shared accounting, explicit artifacts and isolated
file copies. They do not add authority to an Agent or replace tool permissions.

## Shared model budget

```ts
import { FileSharedBudget } from "@may/coordination";

const budget = await FileSharedBudget.open(budgetDirectory, coordinationId, {
  maxModelCalls: 32,
  maxTotalTokens: 262_144,
  // Optional cost accounting requires explicit prices for this provider/model.
  maxCostUsd: 2,
  tokenPrices: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
});
const meteredModel = budget.wrapModel(providerModel, {
  reservation: { totalTokens: 32_768, costUsd: 0.15 },
});
// Share this budget across every model used by the team's Agent definitions.
// After all Runs have stopped:
console.log(await budget.totals());
await budget.close();
```

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
The original per-Run budget remains independent and can further restrict each Run.
Limits and prices must match when reopening a ledger. Stop active model calls before
`close()`; ownership locks are never stolen automatically.

## Immutable artifacts

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
// Or explicitly include workerArtifacts.tools() in the task's Agent definition.
await artifacts.close();
```

Artifacts contain bounded UTF-8 text and immutable metadata: id, owner, name, MIME
type, byte size and SHA-256. IDs and storage paths are host-generated; names are not
filesystem paths. Each task can read its own artifacts. Reading another task's
artifact is denied unless the host ACL returns `true`; knowing an id is not a grant.

`publish_artifact` and `read_artifact` use a task binding supplied by the host, not a
model-controlled owner. A durable command can be acknowledged again only with the
same content. Publication writes and syncs an immutable blob before acknowledging
its journal record. Reads check size, file type and hash. Changed bytes or links are
rejected; a partially written/unreferenced blob is not silently replaced.

Defaults: 256 artifacts, 1 MiB per artifact, 16 MiB total. Limits and ACL version must
match on reopen. `snapshot()` exposes references to the host; it is not a model
catalog or an ACL bypass tool. Use a distinct command id per dispatch/turn output.
Send explicit artifact ids in task messages or answers; content is not automatically
injected into every Agent's context. Treat artifact content as untrusted task data.

## Task workspace copies

```ts
import { TaskWorkspaceManager } from "@may/coordination";

const workspaces = await TaskWorkspaceManager.open({
  sourceDirectory: userCheckout,
  directory: privateTeamDirectory, // Must not overlap the checkout.
});
const workspace = await workspaces.prepare(task.id);
// Bind this task's filesystem tools to workspace.directory, not userCheckout.
const changes = await workspaces.changes(task.id);
// Show changes for review; applying selected patches is a separate user/host action.
await workspaces.close();
```

The manager first snapshots a filtered team baseline, then creates an independent
regular-file copy for each logical task. All tasks start from the same baseline,
even if the source later changes. Turns, handoffs and explicit retries of that
task retain its copy; there is no automatic rollback. The user's checkout is never
modified. There is no automatic Git operation, merge, deletion or write-back.

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

Each store is a single-writer local journal with synced acknowledgements. A partial
last JSONL record can be repaired; complete corruption, changed configuration and
ambiguous writes fail closed. Do not remove locks while an owner may still be live.
These files do not implement distributed locking or automatic stale-lock recovery.
Close the coordination runtime and await its active work before closing resources.
