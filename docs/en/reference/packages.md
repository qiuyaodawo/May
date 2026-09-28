# Package reference

**English** | [简体中文](../../zh-CN/reference/packages.md)

May is a pnpm workspace. Reusable framework code is defined under
`packages/`; executable products live in `apps/`. Applications may depend on
packages, but packages must not import an application.

All packages are currently versioned `0.1.0`. Read
[Compatibility and stability](compatibility.md) before treating a public
surface or persistence format as stable.

## Choose the smallest useful layer

`@may/media` provides reusable image validation, attachments and file storage.
See [Image replies](../guides/images.md) for Terminal, Web UI and channel integration.

| Goal | Start with | Usually add |
| --- | --- | --- |
| Run one model/tool loop in memory | `@may/core` | A provider adapter |
| Define reusable Agent behavior and policy | `defineAgent()` from `@may/application` | A `ToolRegistry` from `@may/core` |
| Build a headless, durable single-session Agent | `AgentDefinition.open()` or `AgentApplication.open()` | `@may/session`, `@may/context`, permissions and tools |
| Manage multiple sessions in one workspace | `@may/application` | A `SessionCatalog` from `@may/session/catalog` |
| Coordinate Agent teams, resources and remote workers | `@may/coordination` | Agent definitions, durable coordination and Session stores, explicit host policies |
| Build a terminal Agent | Headless application controller | `@may/tui`, optionally `@may/keybindings` |
| Build a browser Agent | Product `UiHost` or `ApplicationUiHost` | `@may/ui-client`, `@may/web-ui` |
| Build a coding Agent | Headless application controller | `@may/coding-tools` and an execution isolation policy |
| Select models from May configuration | `@may/config` | `@may/providers` |
| Let the model inspect durable history | `@may/session-tools` | An active `Session` or `AgentApplication` |
| Trace Agent latency and outcomes | Core's `Tracer` port | `@may/observability` processors and exporters |
| Consume tools from MCP servers | `@may/mcp` | `ToolRegistry`, permissions, and optional tracing |

`@may/core` is appropriate when the caller wants to own the complete runtime
lifecycle. `@may/application` is the normal starting point for an application
that needs sessions, approvals, context management and orderly shutdown.

## Runtime and application

### `@may/goal`

Independent goal execution composed through public Agent, Model and Context interfaces.
Provides durable state, bounded continuation and model tools. Base Agent packages
do not depend on it. See [Goals](../guides/goals.md).

### `@may/skills`

Generic Agent Skills discovery, parsing, bounded resource loading and session
activation. `@may/application` composes this with durable state and dynamic
Context instructions. See [Agent Skills](../guides/skills.md).

### `@may/core`

The provider-neutral execution kernel:

- `May`, `Model`, `Tool`, `Context` and `ToolExecutor` contracts;
- instance-scoped `ToolRegistry` composition, lookup and model-definition
  projection;
- Run and Step execution, streaming events and cancellation;
- tool scheduling and normalized messages;
- `InMemoryContext` for small or ephemeral integrations.

Core deliberately does not own durable sessions, provider selection, product
configuration, permission policy or UI. See the
[Core package README](../../../packages/core/README.md).

`ToolRegistry` implements `Iterable<Tool>` and provides `register()`, atomic
`registerAll()`, `has()`, `get()`, `require()`, `size`, `names()`, `values()`,
`definitions()`, `clone()`, iteration and static `compose()`. Ambiguous names
throw `DuplicateToolNameError`. `May` accepts any tool iterable and snapshots
its membership when constructed. Registry snapshots preserve original Tool
identity while guarding the registered descriptor values/references against
later replacement; they do not deep-clone tools or schemas.

### `@may/application`

Headless orchestration above Core:

- `AgentDefinition` and `defineAgent()` capture reusable behavior and policy;
- `AgentApplication` owns one active durable Session;
- `AgentWorkspace` owns active-session selection and Catalog updates;
- `AgentController` and `AgentWorkspaceController` define UI-independent
  control surfaces;
- `AsyncStateSerializer` serializes product and session transitions;
- context inspection and compaction results are persisted through Session;
- optional custom `ToolExecutor` and `ToolScheduler` injection;
- optional `session_history` and tool-presentation support.

Definition-time Models, tools, prompts and policies remain injected product
choices. Storage, Session identity and Session/Context metadata are supplied
to `AgentDefinition.open()`. Every call opens an independent application, but
stateful collaborators captured by the definition—including a custom tool
scheduler—remain caller-owned and shared. Tool iterable membership is
snapshotted when the definition is created.
See [Agent and Application](../concepts/agent-application.md) and the
[package README](../../../packages/application/README.md).

`AgentWorkspace` and `AgentWorkspace.open` accept the generic parameters
`<Event, Extension, Compaction, Run, Application>`. Existing callers that explicitly
specified `Application` as the fourth parameter must insert `AgentRun` or their
application's Run type before it.

### `@may/coordination`

Single-coordinator, durable task graphs above Application. `CoordinationRuntime` runs
host-authored DAGs; `pipeline()` and `parallelTasks()` compile to the same graph.
`createApplicationAgent()` gives each task controller an independent Session, with routed
approvals, per-Run budgets and evidence-based recovery.
`onOpen` binds Session-owned helpers before the first input is submitted.
`resolveRecovery` also accepts queued and waiting tasks while the runtime has not
started and has no active execution. Coordination storage is
in-memory or local single-writer JSONL through `@may/coordination/file-store`.
`createAttachedApplicationAgent()` serves tasks whose Session the host already
owns: the host supplies the Session owner and per-turn submit options, the agent
keeps input identity, the yield boundary and the task cancellation signal, refuses a
second concurrent claim and never opens or closes the host application;
`CreateCoordinationOptions.sessionIds` binds a root task to that Session.
`TaskSpec.files` declares the workspace-relative files a task may modify.
Opt-in `delegate_tasks` supports nested children, safe yield and identified wakeup
turns, with default-deny delegation policy and depth/turn limits. Optional peer
mailboxes add `send_message` / `wait_for_messages`, default-deny message authority,
bounded durable envelopes and per-turn inboxes. Opt-in `handoff_task` transfers a
logical task to a fresh agent Session after a safe yield, with default-deny policy,
explicit context summaries and bounded, durable controller history. Host-only
`retryTask()` creates a new attempt; `rewriteGraph()` atomically edits never-submitted
future nodes. Unknown effects are reconciled, not automatically retried.

`FileSharedBudget`, `FileArtifactStore` and `TaskWorkspaceManager` provide local
shared usage reservations, immutable scoped text artifacts and isolated file copies.
They are not a distributed global budget service or an OS sandbox and do not merge
changes into the source checkout. `@may/coordination/remote` provides independent
remote leaf workers with their own durable receipts and authority; one coordinator
retains scheduling ownership, with no HA/multi-writer failover. MaybeCode's team CLI
uses local agents and defaults to read-only, with configurable plans, structured
verification and host-confirmed recovery. Explicit coding mode permits edits in
private copies; source application is a separate reviewed, host-only patch action,
never an automatic merge. Configured test processes require separate authorization
and are not OS-sandboxed. The CLI adds no arbitrary Shell/MCP tools, remote workers,
or multi-agent TUI.

See [Multi-agent task graphs](../guides/coordination.md),
[Shared resources](../guides/coordination-resources.md),
[Attempts and graph revisions](../guides/coordination-lifecycle.md),
[Remote leaf workers](../guides/coordination-remote.md) and
[MaybeCode teams](../guides/maybecode-team.md).

### `@may/observability`

Optional fail-open tracing implementation for Core's `Tracer` port. It
provides `BasicTracer`, deterministic sampling, immutable completed spans,
in-memory and serialized/bounded processors, and in-memory/JSON-console
plus local JSONL exporters. Core, Application, Session, model, and tool contexts propagate
trace identity without a process-global tracer. Processor lifetime remains
caller-owned. See [Observability and tracing](../guides/observability.md).

### `@may/mcp`

Optional Model Context Protocol client integration. It connects to configured stdio
or Streamable HTTP endpoints, negotiates the protocol and calls `tools/list`, and adapts every discovered
tool to Core's existing `Tool` interface. Model-facing names are namespaced and
collision-checked. Calls forward cancellation and progress, and optional MCP
spans use the injected Core tracer. The client pool owns its spawned processes;
the application that opens it must close it. It also exposes server status and
connection lifecycle events, while retaining a bounded sanitized stderr tail
for diagnostics. `catalog()` exposes versioned metadata and `refresh()`/`reconnect()`
update the pool; `toolSource: () => pool.tools` supplies immutable per-Run tools.
Host-driven resources/templates, prompts, completion and watches support bounded
content and explicit attachment, never automatic URI loading. Native OAuth and an OS-keyring-backed encrypted credential vault
are optional; see [MCP authentication](../guides/mcp-auth.md) and [MCP tools](../guides/mcp.md).

## State and policy

### `@may/context`

Replaceable Context factories and built-in compaction strategies. It provides
an in-memory managed context, inspection, automatic compaction, summary-tail,
history-reference, pruning and model-backed summarization components. Context
is the current model-visible view; it is not the complete durable Session
history. See [Context and history](../concepts/context-and-history.md).

### `@may/session`

Durable conversation identity and facts:

- serialized submissions and continuation;
- Session event history and cursor-based queries;
- in-memory storage;
- optional JSONL file storage through `@may/session/file-store`;
- in-memory and file-backed Catalogs through `@may/session/catalog`.

Use a Catalog to discover sessions; use a Session Store to read or append the
facts belonging to one session.

### `@may/permissions`

A headless `ToolExecutor` implementation that evaluates a `PermissionPolicy`,
publishes approval requests and accepts allow/deny decisions. In-process
session grants are supported; the package is neither a UI nor a sandbox.

### `@may/config`

Loads and validates provider connections, model profiles and application-owned
configuration. The JSON Schema is exported as `@may/config/schema`. See the
[configuration reference](configuration.md).

The runtime `apps` value is generic. The bundled editor schema additionally
describes settings for May's bundled MaybeCode product; third-party
applications must validate their own application section.

## Models and providers

### `@may/providers`

Provides `ProviderAdapterRegistry`, built-in adapter registration, configured
model selection and capability resolution. Registries are ordinary instances,
not process-global state.

Protocol implementations remain separately consumable:

| Package | Protocol |
| --- | --- |
| `@may/provider-openai` | OpenAI Responses API and native compaction |
| `@may/provider-openai-compatible` | Shared Chat Completions-compatible helpers |
| `@may/provider-anthropic` | Anthropic Messages API |
| `@may/provider-deepseek` | DeepSeek Chat |
| `@may/provider-zhipu` | Zhipu GLM Chat |
| `@may/provider-kimi` | Kimi Chat |

An application can use a concrete adapter directly or select one through
`@may/providers`.

`@may/provider-openai-compatible/http` exports `readSseData` and
`parseRetryAfterMs`, shared by all built-in HTTP providers. SSE decoding uses
`eventsource-parser`, supports LF/CRLF/CR line endings and accepts a final event
without a blank line at EOF. The reader releases the response body when aborted
or when iteration ends early. Retry-After values support seconds (including
decimals) and HTTP dates; the result is milliseconds, or `undefined` when the
header is missing or unrecognized.

A Chat Completions chunk carrying a top-level `error` field ends the stream
immediately. The server `message`, `type`, and `code` (string or numeric) are
preserved in the visible error text; an error shape without readable details
produces an explicit description. No `response.completed` is emitted, and a
later `[DONE]` or `finish_reason` does not turn the failure into a success.

## Tools

### `@may/coding-tools`

Workspace-bound read, edit, write and shell tools, plus reusable instruction
loading and coding change previews. The read, edit and write tools accept a
`guard` option that runs the operation inside a path-scoped lock owned by the host,
which is how one workspace serves several concurrent executors. Subpath exports
are:

- `@may/coding-tools/instructions`;
- `@may/coding-tools/change-preview`.

The shell tool executes with the host process permissions and is explicitly
not a sandbox. See [Custom tools](../guides/custom-tool.md).

### `@may/session-tools`

Provides a bounded, read-only `session_history` tool. `AgentApplication` can
install it automatically; lower-level applications can construct it directly.

## Terminal UI

### `@may/tui`

Contains both low-level terminal primitives and Agent-aware projections:

| Export | Purpose |
| --- | --- |
| `@may/tui` | Components, renderer, editor, focus, scroll and terminal driver |
| `@may/tui/node-terminal` | Line-oriented Node terminal adapter |
| `@may/tui/transcript` | Session/live-event transcript store and retained view |
| `@may/tui/tool-renderers` | Instance-scoped tool presentation renderers |
| `@may/tui/slash-commands` | Command parsing and completion state |
| `@may/tui/list-selection` | Filtered list/picker state |

Product commands, labels, layout and controller calls remain application code.
Alternative graphical or remote UIs should consume a headless controller and
do not need `@may/tui`.

### `@may/ui-client` / `@may/web-ui`

For the browser-neutral protocol and browser components, see
[`@may/ui-client`](../../../packages/ui/client/README.md),
[`@may/web-ui`](../../../packages/ui/web/README.md), and the
[Web UI guide](../guides/web-ui.md). They are independent of terminal rendering;
product-specific adapters retain session/task semantics.

### `@may/keybindings`

Maps context-specific key sequences to semantic UI actions. It is optional and
does not own terminal rendering or product commands.

## Reference products

`@may/maybecode` is the primary coding-Agent application and integration
example. It consumes the packages above but is not a prerequisite for using
them. The smaller `@may/cli` demonstrates direct Core usage.

`@may/maybeclaw` is a local durable-task product using Application and Session
directly. It provides a CLI, long-running local host, authenticated Web UI/control
API, Feishu/Telegram private-chat adapters, cancellation and evidence-based recovery.
Task, inbox/outbox and channel policies remain product-owned, not shared framework packages.
See [MaybeClaw](../guides/maybeclaw.md).

Continue with [Getting started](../getting-started.md) or
[Building an Agent](../guides/building-an-agent.md).

Per-Run execution additionally uses `ToolRegistry.snapshot()` to freeze a copied
descriptor/schema and capture callbacks. The optional additive `toolSource` is
resolved once per Run/continue; grants bind to the definition plus host version.
See [custom tools](../guides/custom-tool.md).

`@may/mcp` also exports an opt-in `McpInteractionBroker`: bounded ephemeral
form/URL interaction, scoped modern MRTR continuations and cancellation/expiry.
MaybeCode's controller and both terminal UIs consume it; headless configuration
leaves it disabled unless requested. See [the interaction guide](../guides/mcp.md#scoped-user-interaction-modern-mrtr).


Explicit `McpHostServices` callbacks and endpoint `host` switches add reviewed
Roots/Sampling; `createMcpModelSampler()` makes isolated, bounded provider calls
without executing tools or reading Session Context. Legacy interactive operations
use opt-in single-operation processes/sessions, never guessed ownership on a shared
connection. See [Host compatibility](../guides/mcp.md#roots-sampling-and-legacy-compatibility).


`McpTaskJournal`, `parseMcpTask`, `mcpTaskToUserMessage` and pool task APIs support
opt-in modern Tasks, durable ownership, reviewed input and explicit result attachment.
See [long-running tasks](../guides/mcp-tasks.md).

Graphical hosts can use `pool.openApp`, `mcpAppSandboxResponse` and the browser-only
`@may/mcp/apps-browser` entry point. See [isolated Apps](../guides/mcp-apps.md) for consent,
origin/CSP requirements and unsupported APIs. Terminals retain text fallback.

Independent, authenticated tool/resource/prompt exports use `@may/mcp/server`.
See [server authoring](../guides/mcp-server.md); no listener or Session export starts automatically.
