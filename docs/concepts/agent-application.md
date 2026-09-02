# Agent definition, application, and workspace

May separates reusable Agent configuration from conversation identity and from
the process that currently owns that conversation. For the complete package
boundary, see [Runtime and session boundaries](../architecture/runtime-session.md).
The shorter lifecycle vocabulary is described in
[Session, run, and step](./session-run-step.md).

## Agent definition is currently a concept

An **Agent definition** is the reusable product configuration that determines
how an Agent behaves. It normally includes:

- a `Model`;
- instructions;
- tools and, optionally, a custom `ToolExecutor`;
- a `PermissionPolicy`;
- a `ContextFactory`, context budget, and compaction strategies;
- application choices such as maximum steps and whether to expose session
  history as a tool.

There is currently no exported `AgentDefinition` class or `defineAgent()`
function. A product expresses this concept by constructing
`AgentApplicationOptions`, usually behind its own factory. The definition has
no session id, conversation history, active run, or lifecycle of its own.

This distinction matters during resume: `@may/session` restores durable
conversation facts, but it does not recreate the model, tools, prompt, or
permission policy. The application must supply those parts again. Session
metadata can identify or validate product configuration, but May does not yet
version or migrate arbitrary Agent definitions.

## `AgentApplication`: one active session

`AgentApplication` is the reusable, headless lifecycle owner for exactly one
durable `Session`. `AgentApplication.open()` composes the injected product
configuration into these runtime objects:

```text
AgentApplication
|- Session
|  `- May runtime
|     |- Model
|     |- Context
|     `- Tools -> PermissionToolExecutor -> optional ToolExecutor
`- application event relay
```

Its required inputs are a model, a `SessionStore`, and a permission policy.
Tools, instructions, context configuration, session identity, and the other
policies are optional. The important ownership rules are:

- `metadata` is copied into a newly created Session and is available for
  validation after create or resume.
- `contextMetadata` is sent through the Context to model requests. It falls
  back to Session metadata when not specified.
- `resume: true` requires `sessionId`. Resume rebuilds the runtime from durable
  messages and the application-supplied current configuration.
- `sessionHistory` is opt-in. When configured, the application installs the
  bounded `session_history` tool and reserves that tool name.
- `createToolPresentation` can create application-owned, versioned display
  data before permission evaluation. The data is made durable but is not added
  to model context.
- A custom Context may omit its management controller. In that case context
  inspection or compaction is unavailable rather than emulated.

The class implements the UI-independent `AgentController` interface. It
supports submit, retry, cancellation, approval resolution, history queries,
context inspection and compaction, and close. Its event channel is explained
in [Events and durability](./events.md).

### Active-operation rules

An application permits one active run or context compaction at a time.
`submit()`, `retry()`, and `compactContext()` reject conflicting application
operations. `cancel()` targets the active run first, otherwise the active
compaction, and returns whether it found anything to cancel.

`retry()` is intentionally narrow: it is accepted only when the most recent
durable terminal run event is `run.failed`. It continues the existing Context
without recording another user input. A cancelled or completed latest run is
not retryable through this method.

Changed manual compaction results are persisted before `compactContext()`
returns. Automatic compaction is also persisted before the model request
continues. See [Context and durable history](./context-and-history.md) for why a
compaction checkpoint does not erase prior history.

## `AgentWorkspace`: selecting the active application

`AgentWorkspace` adds multi-session navigation around an active application.
It still owns only **one active `AgentApplication` at a time**. It requires:

- a workspace identifier;
- the `SessionStore` containing histories;
- a separate `SessionCatalog` containing listable summaries; and
- an `openApplication({ sessionId, resume })` factory supplied by the product.

The factory is the current composition seam for an Agent definition. A
workspace uses it for the initial application and every new or resumed
session. The workspace itself does not choose a provider, tools, prompt,
permission policy, or model profile.

At open time an explicit `sessionId` wins. Otherwise, when `autoResume` is
enabled, the workspace asks the Catalog for the most recently used entry in
that workspace and resumes it only if its SessionStore history is non-empty.
If neither condition selects a history, the product factory creates a new
Session. The workspace emits an initial `session.changed` event in both cases,
with `resumed` indicating which path was used.

The workspace provides:

- list, create, resume, rename, and delete operations for sessions;
- delegation of run, approval, history, and Context operations to the active
  application;
- best-effort summary updates after opening and around run completion;
- a failure-tolerant FIFO queue for session and product state transitions;
- `transitionApplication()` for rebuilding product configuration while
  preserving the current Session by default; and
- `runStateTransition()` for product-owned state changes that need the same
  ordering boundary.

Session switching, deletion, renaming, compaction, and application replacement
require an idle active application. `cancel()` and approval resolution are
direct operations rather than queued state transitions.

### Product transitions are not Agent definition storage

A model-profile switch is a typical use of `transitionApplication()`. The
product creates the replacement first; if creation fails, the old application
remains active. By default the replacement must expose the same `sessionId`.
The old application is then closed and its relay drained before the workspace
starts relaying the replacement.

This mechanism does not persist a model profile or other product state by
itself. The product owns that state and may emit a typed extension event after
the transition. Likewise, `AgentWorkspace` is generic over application events,
extension events, and a product-defined compaction-selection type.

## Catalog operations are projections, not transactions

The Catalog is a lightweight projection used for discovery. It is separate
from durable Session history. The default summary derives a title from the
first text input, a preview from the latest non-empty input or assistant text,
and a turn count from submitted inputs.

Renaming changes the Catalog entry, not the Session event log. Deleting uses
the optional delete operations of both `SessionStore` and `SessionCatalog`,
rejects deletion of the active Session, and is not a cross-store transaction.
For the storage and replay consequences, see
[Context and durable history](./context-and-history.md#catalog-versus-history).

## Shutdown order

Close is idempotent, but callers should still await it. The ordering protects
terminal events and persistence from being cut off.

`AgentApplication.close()` performs these steps:

1. Marks the application closed so no new operation can start.
2. Cancels an active run and awaits its result, including its event relay.
3. Aborts and awaits an active context compaction.
4. Closes the permission executor, cancelling unresolved approvals as needed.
5. Awaits any remaining run relays and the permission-event relay.
6. Detaches automatic-compaction sinks.
7. Closes the application event queue.

`AgentWorkspace.close()` first stops accepting state transitions and waits for
already accepted transitions. It then closes the active application, waits for
its event relay and pending Catalog-summary writes, and finally closes the
workspace event queue.

Closing these orchestration objects does not imply that an injected model,
SessionStore, Catalog, or other externally owned resource has its own close
method invoked. Products remain responsible for any additional resource
lifecycle.

## Current limits

`@may/application` is a developer-preview API. It currently does not provide a
first-class Agent-definition registry, multiple simultaneously active
Sessions in one workspace object, multi-Agent delegation, distributed locking,
or transactional coordination between history and Catalog storage.
