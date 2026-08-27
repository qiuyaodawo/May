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

For local persistence, use the Node.js JSONL store:

```ts
import { InMemoryContext, May, type Message } from "@may/core";
import { Session } from "@may/session";
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
const session = await Session.resume({
  id: "session_123",
  store,
  createRuntime(messages: Message[]) {
    return new May({
      model,
      tools,
      context: new InMemoryContext({ messages }),
    });
  },
});
```

`createRuntime` restores application-owned configuration while Session rebuilds
conversation messages from durable events. The file store uses one JSONL file
per session. Files are plaintext and require a single active writer per session;
encryption and cross-process locking are outside the current scope.

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

The package supports new and resumed sessions with in-memory or local JSONL
storage. Forking, compaction, metadata updates, and cross-process coordination
are not implemented yet.
