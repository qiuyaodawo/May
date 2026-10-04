# `@may/session`

`@may/session` composes a configured `@may/core` runtime into a long-lived
conversation identity. It serializes runs and records durable session facts
without making Core depend on persistence or UI policy.

Session accepts the `AgentRuntime` interface. New creation records save its
`RuntimeDescriptor`; `resume()` passes that descriptor through
`SessionRuntimeInfo.runtime`. Incompatible identity, version, or state format
requires an explicit `migrateState(savedDescriptor, state)` implementation;
successful migration is saved as `runtime.changed`. Histories without a descriptor use the default May
runtime identity. Compatibility is checked before interrupted-run repair records
are committed.

Stateful runtimes declare `stateVersion` and implement `saveState()` and
`restoreState()`. Session validates and saves their initial state, then saves
additional state after each settled Run
using `runtime.state.saved`, and restores the latest state when reopened.
`getRuntimeInfo()` returns reconstructed messages and metadata while idle;
`replaceRuntime()` accepts an idle, compatible runtime and transfers any runtime
state, or applies its explicit migration. It closes the previous owned runtime
after replacement. `closeRuntime()` closes an idle instance and rejects later
execution. Concurrent and repeated calls await the same resource cleanup and
preserve its failure. `saveRuntimeState()` supports an explicit idle durability
barrier.
`suspendRuntime()` saves and caches the current descriptor/state, closes that
instance once, and blocks execution. Plugin service replacement can then proceed
without accessing the old runtime after its dependencies are released.
`replaceRuntime()` restores the cached state, applies any explicit migration, and
resumes execution only after accepting the new instance. Failed replacement
retains suspension and readable history for another replacement attempt.
Rejected replacement and failed resume initialization close the new instance.
State inspection and replacement require no active or queued Run. Closing while
an input write is pending releases the unused runtime; once committed, that input
remains available for resume and does not start execution on the closed instance.
Persistent `input.generated` records retain Hook continuation messages and their
reason, and reconstruct those messages without repeating historical tools.

`SessionStore.inspect?(id)` is optional, non-mutating access to committed history.
Both built-in stores implement it. File inspection ignores an incomplete trailing
record without truncation; malformed complete records still fail. Unlike `read()`,
inspection never repairs the journal or changes execution ownership.

`SessionSubmitOptions.inputId` is an optional host delivery identity (1-256
characters), persisted with `input.submitted`. Submitting an already-persisted id
is rejected, including after resume; it does not replay the old input or return
a synthetic Run handle. Input ids are not inserted into model message content.
`AgentApplication.submit()` also accepts this option. A durable `run.yielded`
checkpoint closes a Run without completing the surrounding task; later identified
inputs can continue the same Session after its caller's wait condition is met.

`Session.steer({ input, inputId?, runId? })` durably accepts FIFO input for the
current Run. Its returned `SessionSteeringInput` has `pending`, `delivered`,
`idle`, or `cancelled` status; `listSteeringInputs()` returns current snapshots.
An explicit `runId` must identify the active Run. Inputs enter Context only
after its complete Step, including all tools and approval waits. Pending input
does not interrupt execution. The stored input is copied at acceptance.

Idle input and input remaining after normal completion or host yield have
`idle` status. The host calls `startSteeringInput(inputId, options?)` in FIFO
order to create another Run; it returns the usual `RunHandle`. Cancellation,
failure, and interrupted-process recovery preserve unconsumed input as
`cancelled`; they do not automatically resubmit it. Delivered means committed to
Context, and does not promise the next model call has completed. Cancelled input
requires a new explicit user submission with a new identity.
`cancelSteeringInputs(reason?)` explicitly cancels both pending and idle inputs,
preserves already-delivered input, and completes after the state is persisted.

`SessionSubmitOptions` and `SessionContinueOptions` reserve Step input for this
durable queue. Passing a custom `stepInputSource` to `submit()`, `continue()`, or
`startSteeringInput()` throws `TypeError` before execution. Use `steer()` for
Session input; direct `May.run()` and `May.continue()` retain custom input sources.

Queued, delivered, and finished steering records survive `Session.resume()`.
Only delivered records enter reconstructed Context. Starting idle input uses
the existing `input.submitted` identity, keeping retries and restarts deduplicated.

## Usage

```ts
import { InMemoryContext, May } from "@may/core";
import { InMemorySessionStore, Session } from "@may/session";

const runtime = new May({ model, tools, context: new InMemoryContext() });
const store = new InMemorySessionStore();
const session = await Session.create({ runtime, store });

const run = await session.submit({ input: "Inspect this project" });

for await (const event of run.events) {
  // Live MayEvent values, including streaming deltas.
}

const result = await run.result;
const history = await session.history();
```

For local persistence, use the Node.js JSONL store:

```ts
import { InMemoryContext, May, type Message } from "@may/core";
import { Session } from "@may/session";
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
const session = await Session.resume({
  id: "session_123",
  store,
  createRuntime(messages: Message[], info) {
    return new May({
      model,
      tools,
      context: new InMemoryContext({ messages }),
    });
  },
});
```

`createRuntime` restores application-owned configuration while Session rebuilds
conversation messages from durable events. `info.latestModelMeasurement`
contains the most recent provider-reported input-token count and the number of
messages it measured when available. Old session logs without it remain
compatible. The file store uses one JSONL file
per session. Files are plaintext and require a single active writer per session;
encryption and cross-process locking are outside the current scope.
Both built-in stores implement optional history deletion through
`SessionStore.delete(sessionId)`; applications decide which sessions users may
delete.

## Session catalogs

Session history stores the complete durable event stream. A `SessionCatalog`
is the separate, lightweight index an application can use to list, resume,
rename, and remove sessions without replaying every history file:

```ts
import { FileSessionCatalog } from "@may/session/catalog";

const catalog = new FileSessionCatalog(".may/catalog.json");
await catalog.record({
  id: session.id,
  workspace: process.cwd(),
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  title: "Repository review",
});

const recent = await catalog.list(process.cwd());
```

`InMemorySessionCatalog` is available for ephemeral applications and tests.
The file implementation reads a legacy JSON snapshot and commits each later
record, rename, or remove operation through an atomically renamed file in
`<catalog-path>.operations`. This prevents separate catalog instances from
overwriting each other's updates. Applications with long-lived catalogs should
plan periodic snapshotting or use a database-backed implementation, because
the built-in operation directory is not compacted automatically.

When using `@may/permissions`, connect its durable event sink before submitting
a run:

```ts
permissions.setEventSink((event) => session.recordPermissionEvent(event));
```

This records approval requests, decisions, and cancellations before related
tool outcomes.

`submit()` resolves when that run starts. If another run is active, the
submission waits for it to finish. The returned handle retains Core's live
event stream and cancellation behavior.

Session history contains only durable facts: submitted input, complete
assistant messages, approvals, tool outcomes, and run boundaries. Streaming
deltas and other transient progress events remain on the live run stream.

Successful tool events store raw `output` for host access and the original
model-visible `content` for replay. `sessionToolResultContent(event)` returns that
saved content, including media and deliberately empty projections. Legacy events
without `content` produce an explicit unavailable-content message during replay
and model-facing history queries. Their original `output` remains accessible through
`Session.history()` and `Session.queryHistory()`; hosts must review and explicitly
provide any old result needed by the model.

Applications may attach versioned display metadata to a tool call with
`session.recordToolPresentation(...)`. Session persists and exposes these
`tool.presentation` events, but deliberately ignores them when rebuilding the
model-visible conversation. The `kind`, `version`, and `data` schema remain
owned by the application, keeping Session independent of any particular UI.

`SessionHistoryReader` provides one validated history source for full replay
and bounded queries. `Session.resume()` uses full history, while
`Session.queryHistory()` supports stable sequence cursors, ascending or
descending order, event-type filters, and bounded pages. This lets UIs and
agent-facing tools inspect history without duplicating store-specific logic.

## Session branches

`recordPermissionEvent()` records persistent `rule.created`, `rule.used` and
`rule.revoked` evidence alongside approval events. Approval requests can retain
`persistent: { scopeId, description, definitionKey }`; decisions include
`allow-persistent`. File history validates these records on reading, and
`queryHistory({ types: [...] })` supports their event types. The Session package
owns its durable record types without a runtime dependency on permissions.
Reopening reconstructs model Context from conversation events; permission
evidence stays available in history. Forking replaces approval and rule records
with `history.omitted` entries. Pending approvals are cancelled during recovery,
and the configured permission executor independently checks current saved rules.

`branchPositions()` projects complete requests into selectable history positions.
Successful Runs become available only after `run.settled` confirms that tool
execution, event observation and Runtime state persistence have completed.
Failed, cancelled, interrupted, yielded and older histories without a settlement
record retain an unavailable reason. A host that verifies a yielded request as
successfully completed can call `saveBranchPosition(runId, { allowYielded: true })`
after saving its state. This writes `run.settled` with `hostCompleted: true`.
Positions contain `sessionId`, `runId`,
`positionSeq`, `timestamp`, `request`, `response` and availability.

`Session.fork({ sourceId, positionSeq, store, createRuntime, id?, metadata?,
stateKeys?, transformState?, deferForkReady? })` creates a new independent identity from the exact
selected boundary. It copies historical messages, provider `modelState`, tool
outcomes and versioned Runtime state. Only application state keys explicitly
listed in `stateKeys` are copied. Historical tools are never executed. Permission
records, input delivery identities and unconsumed steering inputs are excluded;
already-delivered steering content remains in Context.
Removed payloads become `history.omitted` records, keeping inherited sequence
numbers stable for application-owned references to historical evidence.

The creation event records `fork: { sessionId, positionSeq, runId }`. A durable
`session.fork.ready` record confirms completion; reopening a partially written
fork rejects with a diagnostic. The source store must provide non-mutating
`inspect()` access. `readSessionBranchNode(history)` exposes durable lineage and
positions for application tree views. Git and workspace selection remain owned
by the host.
`deferForkReady: true` leaves initialization unavailable until the host calls
`saveForkReady()` after completing its resource setup and state writes. The
operation is idempotent and requires an idle, open Runtime.

Hosts that persist additional state after a Run use `deferBranchPositions: true`
when creating or reopening a Session, then call `saveBranchPosition(runId)` after
their state barrier. That operation requires the latest successful Run and no
active execution or state mutation.

Applications can persist a context controller's replacement view with
`session.recordContextCompaction(...)`. This appends a `context.compacted`
event containing the active replacement messages and before/after statistics.
On resume, Session replays that replacement and then applies later events. The
older JSONL events are retained as an auditable full history.

## Current scope

Awaited tool checkpoints and conservative interruption recovery are implemented.
Unknown external outcomes require `listRecoveries()` / `resolveRecovery()` before
continuation. A persistence failure requires reopening the Session. File stores
sync writes and repair incomplete final records; see
[Crash recovery](../../docs/en/guides/recovery.md).

The package supports new, resumed, and deleted histories with in-memory or
local JSONL storage, reusable session catalogs, and durable context-replacement
events and independent selected-position branches. It does not choose or execute
compaction strategies. Cross-process coordination for simultaneous writers to
the same session history remains owned by the storage host.
