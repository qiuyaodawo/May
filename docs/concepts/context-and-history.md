# Context and durable history

**English** | [简体中文](../zh-CN/concepts/context-and-history.md)

May deliberately separates the messages visible to the next model call from
the durable facts kept for a Session. This makes Context replaceable and
compactable without destroying audit history.

See [Session, run, and step](./session-run-step.md) for lifecycle vocabulary,
[Events and durability](./events.md) for event mapping, and
[Runtime and session boundaries](../architecture/runtime-session.md) for
package ownership.

## Two different views

| Concern | Context | Session history |
| --- | --- | --- |
| Primary consumer | Model request | Resume, audit, UI, history tools |
| Minimal interface | `snapshot()` and `append()` | `SessionStore.append()` and `read()` |
| Contents | Instructions, selected messages, request metadata | Durable `SessionEvent` facts |
| May be compacted | Yes | Existing events are retained |
| Must contain streaming deltas | No | No |
| Owns Session identity | No | Yes |
| Recreates tools/model/policy | No | No |

The minimal `@may/core` `Context` contract has no persistence dependency. Core
asks for a snapshot before each model call and appends user, assistant, and tool
messages as execution proceeds. Instructions become a system message in the
model request; Context metadata becomes request metadata.

`@may/context` adds `ContextFactory` and optional management through a
`ContextController`. The built-in `InMemoryContextFactory` returns an in-memory
model view plus a controller for inspection and replacement. A custom factory
may omit the controller, so applications must handle inspection or compaction
being unavailable.

## Inspection and budget

`ContextController.inspect()` reports message counts, role counts, serialized
UTF-8 byte sizes, tool-result count, and token pressure. The fallback token
estimate is explicitly approximate: UTF-8 bytes divided by four.

When a provider reports input-token usage, `AgentApplication` records that
measurement with the number of messages included in the model request. The
controller can use the measured prefix plus an estimate for messages appended
afterward. A `ContextBudget` may reserve output, tool, and safety capacity and
define an automatic-compaction trigger ratio.

These values are capacity signals, not billing or exact tokenizer results.

## Compaction changes Context, not history

A compaction strategy receives a snapshot and returns a replacement message
list. Built-in strategies can prune older large tool results, summarize older
turns, use provider-native compaction, or replace older turns with a durable
history reference. Product code chooses strategy order and prompt policy.

Manual compaction is invoked through the controller or application. Automatic
compaction can run immediately before a model-facing snapshot when the budget
threshold is reached. Strategies run in order until pressure falls below the
threshold or a terminal strategy succeeds. Strategy failures may fall through
to later strategies; exhaustion raises an error rather than silently sending
an over-threshold request.

When replacement succeeds, `AgentApplication` records a
`context.compacted` Session event containing:

- the strategy name;
- the complete replacement message view; and
- before/after message and estimated-token counts.

The event is a durable checkpoint. It does **not** rewrite or remove preceding
Session events. On resume, replay scans the history in order; encountering the
checkpoint replaces the reconstructed message list, then later durable inputs,
assistant messages, and tool outcomes are applied normally.

Only a changed compaction result is persisted. A manual caller receives the
result directly. Successful automatic compaction also emits an application
event, while automatic strategy failure is a live application event and is not
currently a Session event.

## Replay semantics

`Session.resume()` validates the Session id and contiguous Session sequence,
then rebuilds the model view from durable events:

- `input.submitted` restores a user message;
- `assistant.completed` restores the complete assistant message;
- `tool.completed` and `tool.failed` restore tool messages;
- `context.compacted` replaces all messages reconstructed so far;
- a cancelled Run receives synthetic cancellation messages for assistant tool
  calls that have no durable outcome.

Replay also returns the latest usable provider input-token measurement to the
runtime factory. A compaction checkpoint clears an older measurement because
the measured prefix has changed.

Approval events, Run boundaries, and `tool.presentation` remain visible in
history but are not model messages. In particular, tool presentation data is
application-owned display metadata and is deliberately ignored by replay.

Instructions, tools, model selection, permission policy, and arbitrary product
configuration are also not reconstructed from the event log. The application
must inject them when it creates the resumed runtime. This is why history is a
conversation source of truth, not a serialized Agent definition.

## Reading durable history

`Session.history()` returns all validated events after pending record writes
finish. `Session.queryHistory()` provides bounded pages with:

- exclusive `afterSeq` and `beforeSeq` boundaries;
- ascending or descending order;
- event-type filters; and
- a `nextSeq` cursor when more matching events exist.

The default page limit is 50 and the built-in reader's maximum is 1000. An
application can opt into the bounded `session_history` tool through
`AgentApplication.open({ sessionHistory: ... })`; it is not installed by
default.

Built-in storage choices are `InMemorySessionStore` and the Node-only
`FileSessionStore`, which writes one plaintext JSONL file per Session. The file
store serializes writes within one instance but does not provide cross-process
locking, encryption, crash recovery transactions, or multiple-writer safety.

## Catalog versus history

A `SessionCatalog` is a listable index of `SessionSummary` records:

```text
id + workspace + createdAt + lastUsedAt + optional title/preview/turnCount
```

It is not the Session event store and cannot resume a conversation by itself.
Conversely, a SessionStore does not expose a built-in cross-session listing
operation. `AgentWorkspace` uses both: the Catalog discovers a candidate id,
then the SessionStore supplies the history.

The default workspace summary uses the first user text as the title, the most
recent user or assistant text as the preview, and submitted-input count as the
turn count. Built-in catalogs list a workspace's entries by descending
`lastUsedAt`. Catalog writes performed around normal runs are best-effort, so a
missing or stale summary does not mean the underlying history is absent.

Catalog rename is projection-only and does not append a Session event. Session
deletion and Catalog removal are separate operations, not an atomic commit.
The local `FileSessionCatalog` avoids lost updates between catalog instances by
atomically appending operation files, but it does not automatically compact
that operation directory.

## Choosing the source for a feature

- Use **Context** for what the model should see on its next call.
- Use **Session history** for durable conversation facts and replay.
- Use **Catalog** for fast Session discovery and user-facing summaries.
- Use **live events** for animation, partial output, and current progress.

A UI may project all four, but none of its retained widgets is a source of
truth. The orchestration boundary that owns them is described in
[Agent definition, application, and workspace](./agent-application.md).
