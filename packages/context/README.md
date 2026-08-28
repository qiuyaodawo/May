# `@may/context`

Replaceable Context factories and reusable implementations for May agents.

```ts
import { InMemoryContextFactory } from "@may/context";

const factory = new InMemoryContextFactory();
const managed = await factory.create({
  instructions: "You are a coding agent.",
  messages: [],
  metadata: { workspace: process.cwd() },
  budget: {
    contextWindowTokens: 64_000,
    outputReserveTokens: 8_192,
  },
});

const snapshot = await managed.context.snapshot();
const inspection = await managed.controller?.inspect();
```

`InMemoryContextFactory` creates an in-memory implementation of the
`@may/core` `Context` contract.
Applications can accept the `ContextFactory` interface to let callers replace
context storage and model-view selection without changing the Core agent loop.
Factories return a `ManagedContext`: Core receives its `context`, while an
application can use the optional `controller` for management operations such
as inspection. The default token estimate is explicitly approximate and uses
the combined instruction and serialized-message UTF-8 byte count divided by
four. After a model reports `usage.inputTokens`,
`SnapshotContextController` can retain that measured request prefix and
estimate only messages appended afterward. `ContextBudget` carries model
limits and future compaction reserves; it does not currently trigger or
perform automatic compaction by itself.

## Manual compaction

`InMemoryContextFactory` also supplies a replaceable context controller with
`compact()`. Its default `PruneOldToolResultsStrategy` keeps the four most
recent tool results and replaces older results of at least 2 KiB with bounded
placeholders. It preserves message order and tool-call identifiers.

```ts
import {
  InMemoryContextFactory,
  PruneOldToolResultsStrategy,
} from "@may/context";

const managed = await new InMemoryContextFactory().create({
  messages,
  compactionStrategy: new PruneOldToolResultsStrategy({
    keepRecentToolResults: 2,
    minimumResultBytes: 1024,
  }),
});

const result = await managed.controller?.compact?.();
```

Compaction clears stale provider-token measurements and returns the before and
after inspections plus the replacement messages. Applications remain
responsible for persisting those replacement messages. Custom factories may
omit `compact()` or provide a different strategy and storage mechanism.

`SummaryTailStrategy` accepts a replaceable `ContextSummarizer`. It summarizes
complete older user turns into one system message and preserves the configured
number of recent user turns, so assistant tool calls are not separated from
their tool results. The default is two recent turns. An empty summary is
rejected, and a summary that would increase serialized context size is not
applied.

```ts
import { SummaryTailStrategy } from "@may/context";

const strategy = new SummaryTailStrategy({
  keepRecentTurns: 2,
  summarizer: {
    async summarize({ messages, signal }) {
      return summarizeWithYourModel(messages, signal);
    },
  },
});
```
