# `@may/context`

Replaceable Context factories and reusable implementations for May agents.

```ts
import { InMemoryContextFactory } from "@may/context";

const factory = new InMemoryContextFactory();
const context = await factory.create({
  instructions: "You are a coding agent.",
  messages: [],
  metadata: { workspace: process.cwd() },
});
```

`InMemoryContextFactory` creates the existing `@may/core` `InMemoryContext`.
Applications can accept the `ContextFactory` interface to let callers replace
context storage and model-view selection without changing the Core agent loop.
