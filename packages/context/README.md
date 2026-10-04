# `@may/context`

Replaceable Context factories and reusable implementations for May agents.

`ContextFactoryOptions.instructionsSource` supplies dynamic instructions to
inspection and model snapshots, keeping active skills outside message compaction.
Call `invalidateMeasurement()` when instructions change. Custom factories and
controllers must honor these contracts for skill activation.

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
    toolReserveTokens: 2_048,
    safetyMarginTokens: 2_048,
    compactTriggerRatio: 0.9,
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
estimate only messages appended afterward.

`ContextBudget` separates the full model window from the input budget. The
input budget is the context window minus output, tool, and safety reserves.
When `compactTriggerRatio` is present, pressure begins at the smaller of that
fraction of the full window and the input budget. `inspect()` exposes these
values through `inputBudgetTokens`, `compactTriggerTokens`, and
`shouldCompact`.

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

The built-in controller also supports `requestCompaction(strategy)` to defer a
reset until the next model snapshot, after the current tool batch completes.
Passing `undefined` cancels the request. `rollbackCompaction(result)` restores
the previous view if saving its checkpoint fails, preserving appended messages.
After a checkpoint is saved, `commitCompaction(result)` releases the previous
view and makes later `rollbackCompaction(result)` calls preserve the committed
view. It also completes the corresponding deferred compaction request while
preserving requests issued afterward. Manual callers invoke `commitCompaction()` after successful persistence
and `rollbackCompaction()` on persistence failure. Automatic compaction commits
when its persistence sink completes. A sink that performs completion
notifications calls `commitCompaction()` immediately after saving, before those
notifications; notification errors then propagate while preserving the saved
view. Custom controllers providing rollback support should implement this
commit boundary as well.

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

For a tool-free summarizer backed by any May `Model`, use the reusable adapter
and keep prompt policy in the application:

```ts
import { createModelContextSummarizer } from "@may/context/model-summarizer";

const summarizer = createModelContextSummarizer(model, {
  instructions: "Return a concise continuation summary.",
  requestText: "Summarize the preceding conversation now.",
});
```

The adapter forwards cancellation and validates that the model emits exactly
one completed, non-empty text response without attempting to call tools. It also
forwards the strategy's `runId` and `step` to `Model.stream`, so a host that meters
the same model can give the summary call a stable identity instead of an anonymous
one.

## Automatic compaction

`InMemoryContextFactory` can run an ordered strategy chain immediately before
Core takes a model-facing snapshot:

```ts
const managed = await new InMemoryContextFactory().create({
  messages,
  budget: {
    contextWindowTokens: 64_000,
    outputReserveTokens: 8_192,
    compactTriggerRatio: 0.9,
  },
  autoCompactionStrategies: [
    new PruneOldToolResultsStrategy(),
    strategy,
  ],
});

managed.controller?.setAutoCompactionSink?.(async (result) => {
  await persistReplacementView(result.messages);
});
```

Strategies run in order until pressure falls below the threshold. Unchanged
strategies fall through to the next strategy. If every strategy is exhausted,
the same message snapshot is not retried until the context or model
measurement changes. The run's cancellation signal is forwarded to each
strategy. The sink is awaited so an application can durably record a changed
view before the model request proceeds.

Lifecycle control failures identified by `HookExecutionError` propagate
immediately during automatic strategy selection. This preserves the active
Hook's decision and its original error cause.

Models may expose a provider-native `contextCompactor`. Wrapping it with
`ModelContextCompactionStrategy` preserves adapter-owned opaque state, accepts
a provider-supplied effective token measurement, and terminates the current
strategy chain after successful native compaction. A compactor that reports the
usage of its own compaction request returns it in `ModelContextCompactionResult.usage`
so the caller can account the request; Core does not inspect that state or contain
provider-specific types.

`HistoryReferenceStrategy` is a final, provider-independent fallback. It
replaces older turns with one system reference while retaining the configured
number of recent user turns. Applications can point that reference at a
bounded history tool, file, or another durable resource without coupling the
context package to session storage.
