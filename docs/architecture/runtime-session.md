# Runtime and session boundaries

May uses four lifecycle levels:

```text
Agent definition -> Session -> Run -> Step
```

Application orchestration sits around these lifecycle levels rather than
adding another model-execution level. An `AgentApplication` owns one active
Session, while an `AgentWorkspace` selects and replaces the active application
when a product creates, resumes, or reconfigures a session.

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

Reusable code lives under `packages`; executable product composition lives
under `apps`. The dependency rule is:

```text
apps/*
  |-> @may/application -> context / session / permissions / core /
  |                      session-tools
  |-> @may/tui         -> coding-tools / keybindings / session /
  |                      permissions / core
  `-> provider / tool / config packages
```

This is a layering sketch, not a requirement that every package depend on
every package to its right. The invariant is that reusable packages do not
import an application. In particular, no package imports `apps/maybecode`.

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
storage seam. It also provides reusable in-memory and file-backed session
Catalog implementations. It may depend on `@may/core`; Core must not depend on
it.

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

### `@may/application`

The application package provides headless orchestration above Session and
Core. `AgentApplication` owns one durable Session and centralizes:

- creating or resuming a Session from injected model, tools, Context factory,
  permission policy, instructions, and storage;
- submission, retry, cancellation, approval resolution, and safe shutdown;
- relaying normalized run and permission events;
- context inspection, compaction cancellation, and persistence of changed
  model-visible context;
- optional bounded `session_history` installation and durable, model-invisible
  tool-presentation metadata.

`AgentWorkspace` adds the active-session catalog, auto-resume, session
creation/resume/rename/delete, catalog summaries, and a FIFO state-transition
queue. A product can rebuild the active application on the same Session through
`transitionApplication`, or serialize product-only configuration work through
`runStateTransition`.

These classes provide ordering and dependency-injection seams; they do not
define a provider registry, a system prompt, a coding permission policy, model
profiles, UI commands, or terminal rendering. The current JSONL Session store
and append-only file Catalog remain lightweight local backends rather than a
claim of crash-proof, multi-host production storage.

### `@may/tui`

The TUI package is May's terminal component package and is intentionally
Agent-aware. It contains two internal levels without splitting them into
another package:

- terminal primitives such as text, editor, selection, scrolling, overlay,
  focus, screen buffer, renderer, and Node terminal adapters;
- Agent projections such as `TranscriptStore`, `TranscriptView`, and the
  instance-scoped `ToolRendererRegistry`.

The Agent layer consumes Core, permission, and Session events and builds a
retained transcript. It is exposed through `@may/tui/transcript` and
`@may/tui/tool-renderers`. Product labels, notices, layouts, commands, and
controller calls are still supplied by the application. A graphical or remote
UI can ignore `@may/tui` and consume a headless controller directly.

### `apps/maybecode`

MaybeCode is an application composition layer, not another runtime. It selects
and configures reusable packages, delegates generic one-session and workspace
lifecycle to `@may/application`, uses `@may/tui`'s Agent transcript, and exposes
a terminal coding-agent product. No reusable package depends on MaybeCode.

The application keeps only product policy and compatibility adapters:

- the MaybeCode prompt, instruction-source policy, and shell runtime guidance;
- the default coding tools, change-preview generation, and coding permission
  policy;
- named manual compaction choices and the ordered automatic compaction chain;
- provider/model profiles, reasoning-effort overrides, and default-model
  persistence;
- slash-command definitions, product events, theme, page layout, model/session
  picker flows, and classic-versus-retained terminal behavior.

`MaybeCodeApplication` is now a product composition wrapper around
`AgentApplication`. It maps generic tool-presentation events to the existing
change-preview event while delegating run, approval, history, Context, and close
operations. `MaybeCodeWorkspace` similarly wraps `AgentWorkspace` and retains
primarily model-profile and effort policy.

Its explicit product UI boundary is `MaybeCodeController`: user intents are
methods, while asynchronous model, tool, permission, context, and session
changes are a `MaybeCodeEvent` stream. `MaybeCodeWorkspace` implements this
headless contract.
The bundled frontends consume this contract. Another UI can consume the same
controller without inheriting MaybeCode's rendering or command policy.
`MaybeCodeTerminal` is a narrower line-oriented I/O adapter for reusing the
classic frontend rather than the custom-UI boundary.

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
