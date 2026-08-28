# `@may/context`

Replaceable Context factories and reusable implementations for May agents.

```ts
import { InMemoryContextFactory } from "@may/context";

const factory = new InMemoryContextFactory();
const managed = await factory.create({
  instructions: "You are a coding agent.",
  messages: [],
  metadata: { workspace: process.cwd() },
});

const snapshot = await managed.context.snapshot();
const inspection = await managed.controller?.inspect();
```

`InMemoryContextFactory` creates the existing `@may/core` `InMemoryContext`.
Applications can accept the `ContextFactory` interface to let callers replace
context storage and model-view selection without changing the Core agent loop.
Factories return a `ManagedContext`: Core receives its `context`, while an
application can use the optional `controller` for management operations such
as inspection. The default token estimate is explicitly approximate and uses
the combined instruction and serialized-message UTF-8 byte count divided by
four.
