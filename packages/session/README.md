# `@may/session`

`@may/session` composes a configured `@may/core` runtime into a long-lived
conversation identity. It serializes runs and records durable session facts
without making Core depend on persistence or UI policy.

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
events. It does not choose or execute compaction strategies. Forking and
cross-process coordination for simultaneous writers to the same session
history are not implemented yet.
