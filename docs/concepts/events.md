# Events and durability

May has several event layers because model streaming, live application state,
and durable Session replay have different requirements. They are related but
are not interchangeable.

See [Session, run, and step](./session-run-step.md) for lifecycle boundaries,
[Context and durable history](./context-and-history.md) for replay, and
[Runtime and session boundaries](../architecture/runtime-session.md) for the
overall package design.

## Event layers

### `ModelEvent`

A model adapter yields provider-neutral `ModelEvent` values for one request:
text and reasoning deltas, retry notices, and exactly one completed response.
These values do not carry Session identity. Core validates the completion
protocol and turns them into Run events.

### `MayEvent`

`MayEvent` is the live observation stream for one Run. Every event has a
`runId`, Run-local monotonic `seq`, and timestamp. It covers:

- Run and Step start/completion;
- model start, deltas, retry notices, and completed messages;
- tool start, output deltas, progress, completion, and failure; and
- Run completion, failure, or cancellation.

`model.completed` contains the complete assistant message, so correctness does
not depend on retaining every earlier delta. Tool terminal events likewise
contain the final output or serialized error.

### `PermissionEvent`

`PermissionToolExecutor` exposes live approval-request, resolution, and
cancellation events. `AgentApplication` relays them as
`{ type: "permission.event", event }`. Its awaited Session sink records the
corresponding durable approval facts in the correct order.

### `SessionEvent`

`SessionEvent` is the durable, Session-sequenced log. Every event has a
`sessionId`, contiguous `seq`, and timestamp. Session maps only facts needed
for replay, history, or audit:

- Session creation and submitted input;
- Run start and terminal boundary;
- complete assistant messages and tool outcomes;
- approval requests, decisions, and cancellations;
- Context-compaction checkpoints; and
- versioned application tool presentations.

It deliberately omits Step lifecycle, model start, model retries, tool start,
streaming output, and transient progress. Session history is therefore a
durable conversation log, not a complete telemetry trace.

### `AgentApplicationEvent`

The headless application stream wraps live Core and permission events and adds
application-level facts:

```ts
type AgentApplicationEvent =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent }
  | { type: "tool.presentation"; presentation: SessionToolPresentation }
  | { type: "context.compacted"; /* automatic success */ }
  | { type: "context.compaction.failed"; /* automatic failure */ };
```

Tool presentations are persisted before their application event is emitted
and before permission-policy evaluation proceeds. Successful automatic
compaction is persisted before its event is emitted and before the model call
continues. A manual compaction returns its result to the caller and persists a
changed replacement, but does not currently emit the same application success
event.

### `AgentWorkspaceEvent`

The workspace relays active-application events in order and adds
`session.changed`. A product can widen the union with typed extension events,
for example after a model-profile transition. `session.changed` describes the
active application selection; it is not itself appended to Session history.

## Persistence-before-observation guarantees

Session observes Core's Run stream and maps durable events one at a time. For
each mapped event it awaits `SessionStore.append()` before forwarding that
`MayEvent` through the Session-wrapped Run stream. Therefore an application
that observes a mapped terminal or completed event can subsequently query the
corresponding durable fact, assuming the same successful store operation.

Other important ordering points are:

- normal `input.submitted` is committed before Core starts the Run;
- an approval request is recorded after its assistant message is durable and
  before the related tool outcome;
- approval resolution/cancellation is ordered after its request;
- automatic compaction is recorded after the Step begins and before the model
  snapshot proceeds; and
- application and workspace shutdown await their event relays before closing
  their queues.

A Session storage failure is not treated as a harmless logging failure. Session
cancels the underlying Run and rejects the wrapped Run result rather than
continuing with history and Context out of sync.

Catalog summary updates are different: `AgentWorkspace` treats many of them as
best-effort projection writes. Catalog state must not be used as a substitute
for the ordering guarantees of Session history.

## Backpressure and droppable streaming events

Core, Session, AgentApplication, and AgentWorkspace use bounded relay queues
with a default target of 1024 buffered values. The following `MayEvent` types
are classified as streaming and may be discarded when a consumer falls behind:

- `model.text.delta`;
- `model.reasoning.delta`;
- `tool.output.delta`; and
- `tool.progress`.

The queue never intentionally discards a non-droppable lifecycle or terminal
event. When the target is full, it first removes an already buffered droppable
event to make room. If none exists, a new droppable event is discarded; a new
non-droppable event is retained even if that temporarily exceeds the target.

Consequences for consumers:

- gaps in a live Run's `seq` are expected under pressure and do not imply a
  missing durable fact;
- deltas are suitable for responsive display, not exact transcript storage;
- finalized assistant messages and tool terminal events should reconcile any
  partial UI state; and
- durable history remains independent of whether a UI consumed every live
  value.

`AgentWorkspaceOptions.isDroppableEvent` can replace the default classification
for a product event union. A custom predicate should preserve every event that
cannot be reconstructed; marking a terminal or product state transition as
droppable weakens the default guarantee.

The current `AsyncEventQueue` is a queue, not a replayable broadcast bus.
Consumers should establish one owning relay or explicitly fan out events if
multiple independent readers need every value. A late consumer receives only
values that remain buffered when it reads plus future values; historical facts
must be read from Session history.

## Live events do not become durable automatically

Adding a new `MayEvent` or product extension event does not make it durable.
Durability requires an explicit Session event schema and an awaited record
path. Application display data should use an application-owned, namespaced
`kind` and decoder. Session validates a non-empty `kind` and positive `version`,
but treats `data` as opaque and never injects it into Context.

Use this rule when extending May:

```text
animation/progress -> live event
conversation/replay fact -> Session event
fast discovery -> Catalog projection
model-visible state -> Context (plus a durable checkpoint when replaced)
```

## Shutdown and the end of a stream

An application or workspace event stream ends after that owner closes its
queue. Correct shutdown cancels active work, waits for Run and permission
relays, and only then closes the application queue. Workspace shutdown waits
for the application relay and pending Catalog-summary work before closing its
own queue. A Run's own stream instead closes automatically when that Run
settles.

Callers should await `close()` and let their `for await` consumer finish rather
than abandoning it as soon as cancellation is requested. The exact lifecycle
order is documented in
[Agent definition, application, and workspace](./agent-application.md#shutdown-order).
