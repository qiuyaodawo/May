# Runtime and session boundaries

May uses four lifecycle levels:

```text
Agent definition -> Session -> Run -> Step
```

## Vocabulary

### Agent definition

The reusable configuration that determines how an agent behaves: its model,
tools, instructions, and default execution policy. It has no conversation
identity or active work by itself.

### Session

A long-lived conversation and work identity. A session owns history and
session-scoped state across multiple runs and may exist while no run is active.
Persistence, resume, fork, compaction, and session-scoped permission grants
belong here.

A session may have at most one active run. Session storage is a separate
capability so an in-memory session does not require filesystem dependencies.

### Run

One execution started by user input. A run continues until the model finishes,
the step limit is reached, it fails, or it is cancelled. `May.run()` and its
event stream form this boundary.

### Step

One model request followed by execution of the tool calls in that response. A
tool result can cause another step in the same run. Step limits therefore bound
model/tool iterations, not the number of tools: one step may contain multiple
tool calls.

## Package responsibilities

### `@may/core`

Core owns active execution:

- model, tool, and context contracts
- the run and step loop
- live run events and cancellation
- tool dispatch through a replaceable executor

Core does not own session discovery, persistence, resume, fork, user-interface
state, or a specific permission policy. It must remain usable for an ephemeral
one-shot run.

### `@may/session`

The session package composes Core into a long-lived identity. It owns a session
id, metadata, serialized submission, context continuity, session events, and a
storage seam. It may depend on `@may/core`; Core must not depend on it.

### `@may/permissions`

Raw tools contain capabilities, not terminal interaction. Core exposes a
general tool-executor seam. The permissions package implements that seam to
allow, deny, or suspend execution for approval. Its policy receives parsed tool
input, and its approval events form a headless protocol: a TUI only renders a
request and returns a decision.

The permission executor supports one-time decisions and explicit scoped grants
for its lifetime. Applications use one executor per Session so grants cannot
leak between sessions. Its awaited event sink lets Session persist approval
requests and decisions before related tool outcomes. Durable grants remain
future storage work and do not belong to the UI.

### `apps/maybe-code`

MaybeCode is an application composition layer, not another runtime. It creates
Core runtimes from configuration, coding tools, permissions, and Session; owns
their lifecycle; and exposes a terminal interface. No reusable package depends
on MaybeCode.

## Events and persistence

`MayEvent` is a live observation of one run and may include streaming deltas.
`PermissionEvent` reports live approval requests and their resolution or
cancellation. `SessionEvent` records durable session facts such as submitted
messages, finalized assistant messages, approvals, tool outcomes, and run
boundaries. UI state is a projection of these events and is never the source of
truth.

The session package includes in-memory storage and an optional Node.js JSONL
file-store entry point. Sessions can rebuild Core context from durable history;
the history model does not depend on a terminal UI or a specific backend.
