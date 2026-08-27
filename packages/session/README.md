# `@may/session`

`@may/session` composes a configured `@may/core` runtime into a long-lived
conversation identity. It serializes runs and records durable session facts
without making Core depend on persistence or UI policy.

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

## Current scope

The initial package creates new in-memory sessions. `SessionStore` is the seam
for future durable backends, but reopening, forking, compaction, and metadata
updates are not implemented yet.
