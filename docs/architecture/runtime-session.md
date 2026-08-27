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

The session package will compose Core into a long-lived identity. It will own a
session id, metadata, serialized submission, context continuity, session events,
and a storage seam. It may depend on `@may/core`; Core must not depend on it.

### Permission runtime

Raw tools contain capabilities, not terminal interaction. Core exposes a
general tool-executor seam. A permission package can implement that seam to
allow, deny, or suspend execution for approval. Pending approvals and
session-scoped grants belong to the headless session/runtime protocol. A TUI
only renders a request and returns a decision.

## Events and persistence

`MayEvent` is a live observation of one run and may include streaming deltas.
A future `SessionEvent` represents durable session facts such as submitted
messages, finalized assistant messages, tool outcomes, run boundaries, and
approval decisions. UI state is a projection of these events and is never the
source of truth.

The first session implementation can be in-memory, but its history model must
not depend on a terminal UI or a specific storage backend.
