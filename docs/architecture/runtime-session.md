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
Persistence, resume, fork, durable context checkpoints, and session-scoped
permission grants belong here.

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
- tool dispatch through replaceable executor and scheduler seams
- normalized multimodal content and provider-owned conversion boundaries

A Core runtime rejects overlapping runs by default because it owns one mutable
Context. Session additionally serializes submissions as a lifecycle policy.

Core does not own session discovery, persistence, resume, fork, user-interface
state, or a specific permission policy. It must remain usable for an ephemeral
one-shot run.

### `@may/context`

The context package provides factories and reusable implementations of Core's
minimal `Context` contract. Applications can replace how model-visible history
is stored or selected without changing the agent loop. It does not own session
identity or durable history. A factory may also expose a `ContextController`
for application-level inspection, manual compaction, and pre-model automatic
compaction. Core only forwards run metadata and cancellation when requesting a
snapshot; strategy selection and durable replacement events remain outside
Core's minimal execution contract.

A model adapter may optionally expose a provider-native context compactor.
Core defines only the opaque capability boundary. `@may/context` adapts it into
the automatic strategy chain, while the owning provider serializes and
restores native continuation state through `modelState`.

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

### `apps/maybecode`

MaybeCode is an application composition layer, not another runtime. It creates
Core runtimes from configuration, coding tools, permissions, and Session; owns
their lifecycle; and exposes a terminal interface. No reusable package depends
on MaybeCode.

Its explicit UI boundary is `MaybeCodeController`: user intents are methods,
while asynchronous model, tool, permission, context, and session changes are a
`MaybeCodeEvent` stream. `MaybeCodeWorkspace` implements this headless contract.
The bundled TUI depends only on the contract, so another TUI can consume the
same controller without implementing readline or inheriting the default
rendering and command policy. `MaybeCodeTerminal` is a narrower I/O adapter for
reusing the bundled TUI rather than the custom-UI boundary.

## Events and persistence

`MayEvent` is a best-effort live observation of one run and may include
streaming deltas. Slow consumers can observe sequence gaps when bounded relay
queues discard high-volume deltas; finalized results and durable facts do not
depend on retaining every delta.
`PermissionEvent` reports live approval requests and their resolution or
cancellation. `SessionEvent` records durable session facts such as submitted
messages, finalized assistant messages, approvals, tool outcomes, and run
boundaries. Applications may also record namespaced, versioned
`tool.presentation` metadata. Session exposes but does not replay this metadata
into model context. UI state is a projection of these events and is never the
source of truth.

The session package includes in-memory storage and an optional Node.js JSONL
file-store entry point. Sessions can rebuild Core context from durable history;
the history model does not depend on a terminal UI or a specific backend.
