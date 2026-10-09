# Package reference

**English** | [简体中文](../../zh-CN/reference/packages.md)

Use this reference to locate a package, its public import paths and the guide for
configuring it. Reusable framework code lives in `packages/`; executable products
live in `apps/`. Applications depend on packages, and packages keep their imports
within the reusable layer.

The packages in this checkout are versioned `0.1.0`. The repository requires
Node.js `>=22.16.0` and pnpm `12.4.2`. Read
[Compatibility and stability](compatibility.md) for public API and persistence
format stability. An import path listed here is a package export; installation
and release scope are governed by the repository's release configuration.

## Choose a package for your task

| Goal | Start with | Usually add |
| --- | --- | --- |
| Run a model/tool loop in memory | `@may/core` | A provider adapter |
| Define reusable Agent behavior and policy | `defineAgent()` from `@may/application` | `ToolRegistry` from `@may/core` |
| Build a durable single-session Agent | `AgentDefinition.open()` or `AgentApplication.open()` | `@may/session`, `@may/context`, permissions and tools |
| Manage several Sessions | `AgentWorkspace` from `@may/application` | `SessionCatalog` from `@may/session/catalog` |
| Coordinate teams and remote workers | `@may/coordination` | Agent definitions, durable stores and host policies |
| Continue work toward a durable goal | `@may/goal` | A host Agent and bounded continuation policy |
| Trigger tasks on a schedule or event | `@may/scheduler` | SQLite storage and an idempotent dispatcher |
| Evaluate task results across configurations | `@may/eval` | Execution adapters, isolated environments, evaluators and reports |
| Extend an application with lifecycle Hooks | `@may/plugin` | `@may/plugin-services` and reusable plugins |
| Build a terminal Agent | An application controller | `@may/tui` and optionally `@may/keybindings` |
| Build a browser Agent | `UiHost` or `ApplicationUiHost` | `@may/ui-client` and `@may/web-ui` |
| Build a coding Agent | An application controller | `@may/coding-tools` and an execution isolation policy |
| Select models from configuration | `@may/config` | `@may/providers` |
| Read durable history through a tool | `@may/session-tools` | An active `Session` or `AgentApplication` |
| Validate and store image replies | `@may/media` | A host `MediaReader` for URL or file sources |
| Trace execution and inspect diagnostics | Core's `Tracer` interface | `@may/observability` |
| Consume or expose MCP capabilities | `@may/mcp` | Permissions and reviewed host services |

For a complete application lifecycle with Sessions, approvals, Context management
and shutdown, start with [Building an Agent](../guides/building-an-agent.md).

## Runtime and application

### `@may/core`

The provider-neutral execution kernel exports `May`, `Model`, `Tool`, `Context`,
`ToolExecutor`, `ToolScheduler` and `InMemoryContext`. It runs model/tool Steps,
streams events, schedules tools and propagates cancellation. Storage, provider
selection, application configuration, permission policy and UI belong to the
host application.

`ToolRegistry` implements `Iterable<Tool>`. Its API includes `register()`, atomic
`registerAll()`, `has()`, `get()`, `require()`, `size`, `names()`, `values()`,
`definitions()`, `clone()`, iteration and static `compose()`. Ambiguous names
throw `DuplicateToolNameError`. A registry keeps the original Tool identity and
checks registered descriptor values and references for later replacement;
registration keeps schema references without deep freezing them.

`May` snapshots iterable membership at construction. Each Run uses
`ToolRegistry.snapshot()` to freeze copied descriptors and schemas and capture
callbacks. An optional additive `toolSource` is resolved once for each
Run/continue; authorization binds the tool definition and host version. See
[Custom tools](../guides/custom-tool.md) and the
[Core README](../../../packages/core/README.md).

### `@may/application`

Headless orchestration above Core exports:

- `AgentDefinition` and `defineAgent()` for reusable behavior and policy;
- `AgentApplication` for one active durable Session;
- `AgentWorkspace` for active Session selection and Catalog updates;
- `AgentController` and `AgentWorkspaceController` for UI-independent control;
- `AsyncStateSerializer` for serialized application and Session transitions.

Definitions snapshot tool iterable membership. Each `open({ store, ... })`
creates an independent application/Session lifecycle with host-supplied storage,
identity and metadata. Captured Models, Context factories, executors and
schedulers remain caller-owned; opening applications reuses these collaborators.
Session persists Context inspection and compaction results. Applications can
install `session_history` and tool presentation support.

`AgentWorkspace` and `AgentWorkspace.open` use the generic parameter order
`<Event, Extension, Compaction, Run, Application>`.
`@may/application/git-workspace` exports `ProjectGitWorkspace` and its checkpoint,
diff, restore and worktree types for host-controlled Git workflows.
See [Agent and Application](../concepts/agent-application.md) and the
[Application README](../../../packages/application/README.md).

### `@may/coordination`

`CoordinationRuntime` executes a host-defined DAG under one coordinator.
`pipeline()` and `parallelTasks()` produce the same graph structure.
`createApplicationAgent()` opens an independent Session for each task controller,
routes approvals and supports per-Run budgets and evidence-based recovery.
`onOpen` binds Session-owned helpers before the first input.

`createAttachedApplicationAgent()` binds a host-owned application to a task. The
host supplies Session ownership and per-turn submit options; the adapter maintains
input identity, safe yield and cancellation, rejects a second concurrent claim
and leaves opening and closing the application to the host.
`CreateCoordinationOptions.sessionIds` binds root tasks to existing Sessions.
`TaskSpec.files` declares workspace-relative files a task may modify.

Optional capabilities are explicitly authorized by the host:

- `delegate_tasks`: nested tasks, safe yield and identified wakeup turns, bounded
  by task count, depth and turn limits;
- `send_message` / `wait_for_messages`: bounded durable peer messages and per-turn
  inboxes;
- `handoff_task`: transfer of a logical task to a new Agent Session with an
  explicit context summary and durable controller history;
- `retryTask()`: a host-only new Attempt;
- `rewriteGraph()`: a host-only atomic change to future, never-submitted nodes.

Delegation, messaging and handoff policies default to denial. Recovery reconciles
unknown effects before scheduling more work. `resolveRecovery()` also accepts
queued and waiting tasks before the runtime starts, when no execution is active.

| Import path | Purpose |
| --- | --- |
| `@may/coordination` | Runtime, graph builders, Agent adapters, policies and resource interfaces |
| `@may/coordination/file-store` | `FileCoordinationStore` local single-writer coordination journal |
| `@may/coordination/remote` | Remote leaf Worker, durable receipts and authenticated transport |

The main `@may/coordination` entry exports `FileSharedBudget` for shared usage
reservations and `FileArtifactStore` for
immutable, scoped text artifacts. `TaskWorkspaceManager` manages isolated file
copies; applying their changes requires a host action. These resources use local
ownership and journaling. Remote Workers retain their own receipts while one
coordinator owns scheduling; high-availability or multiple-writer failover is
outside the current transport.

See [Task graphs](../guides/coordination.md),
[Shared resources](../guides/coordination-resources.md),
[Attempts and graph revisions](../guides/coordination-lifecycle.md),
[Remote Workers](../guides/coordination-remote.md) and
[MaybeCode teams](../guides/maybecode-team.md).

### `@may/goal`

Durable goal state, bounded continuation and model-facing goal tools compose
through public Agent, Model and Context interfaces. The host supplies execution
and continuation policy. See [Goals](../guides/goals.md).

### `@may/scheduler`

Durable scheduling supports one-shot times, five-field timezone-aware cron,
host-published events, atomic event deduplication and restart-safe submission.
Hosts call `start()` or `tick()` and own Agent execution, permissions, concurrency
and result delivery. `@may/scheduler/sqlite-store` exports exclusive SQLite
storage. See [Scheduling](../guides/scheduler.md) for dispatcher idempotency,
misfire policies and recovery.

### `@may/eval`

`EvalRunner` validates and expands versioned Cases and Variants into Trials,
executes them in isolated environments, runs independent evaluators and produces
durable Reports. Runtime outcome and task verdict are separate report fields.

| Import path | Purpose |
| --- | --- |
| `@may/eval` | Types, registry, validation, runner, environments, evaluators, reports, commands and telemetry |
| `@may/eval/application` | `createApplicationExecutionAdapter()` for fresh application Sessions |
| `@may/eval/coordination` | `createCoordinationExecutionAdapter()` and `EvalTrialBudget` for fresh task graphs |
| `@may/eval/file-store` | `FileEvalStore` for exclusive local experiment storage |

Adapters require a version, fresh execution resources and bound trial budgets.
Suite modules and command evaluators execute trusted host code. Cancellation and
restart preserve unknown-effect evidence for host reconciliation. See
[Evaluate Agent task results](../guides/eval.md).

### `@may/plugin`

Scoped plugin hosting provides typed versioned services, dependency validation,
configuration schemas, state migration, ordered lifecycle Hooks, resource cleanup
and serialized composition changes. Application integrates plugins with Agent
definitions, runtime factories and durable Sessions. See
[Plugins, services and lifecycle Hooks](../guides/plugins.md).

### `@may/plugin-services` and reusable plugins

Shared service tokens and ordered registries describe tool, instruction, Model
and Context contributions. Application reexports tokens through
`applicationServices` and composes direct options through plugin factories.

The 15 reusable `@may/plugin-*` packages in `packages/plugins/` are listed with
their factory APIs in the [plugin package catalog](../guides/plugins.md#reusable-plugin-packages).
`@may/plugin-agent-adapters/rpc` and
`@may/plugin-agent-adapters/examples/rpc-file-agent` provide the RPC adapter and
its example. Product combinations live in each application's `src/plugins/`.
`pnpm test:package:plugin` verifies independently installed tarballs and their
runtime dependency chains.

### `@may/skills`

Agent Skills discovery, parsing, bounded resource loading and Session activation.
Application integrates skills with durable state and dynamic Context instructions.
See [Agent Skills](../guides/skills.md).

### `@may/observability`

Tracing and diagnostics implement Core's optional `Tracer` interface. Exports
include `BasicTracer`, deterministic sampling, immutable completed spans,
in-memory and serialized/bounded processors, and memory, JSON console and local
JSONL exporters. `OpenTelemetryTracer`, `OpenTelemetryMetricRecorder` and
`createOtlpTelemetry()` integrate external telemetry. `DiagnosticsStore` and
`TaskAssessment` support application diagnostics and task assessment.

Core, Application, Session, Model and tool contexts explicitly propagate trace
identity. The host owns processor lifetime and cleanup. See
[Observability and tracing](../guides/observability.md).

### `@may/mcp`

The client pool connects to configured stdio or Streamable HTTP endpoints,
negotiates MCP and adapts discovered tools to Core `Tool`. Model-visible names
include namespaces and collision checks. Calls propagate cancellation, progress
and optional injected tracing. The opening application must close the pool and
the processes it owns. Server status, lifecycle events and bounded sanitized
stderr support diagnostics.

`catalog()` returns versioned metadata. `refresh()` and `reconnect()` update the
pool; `toolSource: () => pool.tools` binds an immutable tool set for each Run.
Host-driven resources/templates, prompts, completion and watches use bounded
content and explicit attachments. Additional exports include:

- `McpInteractionBroker` for opt-in bounded form/URL interaction, owned modern
  MRTR continuations, cancellation and expiry;
- `McpHostServices` and endpoint `host` switches for reviewed Roots/Sampling;
  `createMcpModelSampler()` makes isolated, bounded provider calls with tool
  execution disabled and without access to Session Context;
- `McpTaskJournal`, `parseMcpTask`, `mcpTaskToUserMessage` and pool task APIs for
  opt-in modern Tasks, durable ownership and explicit result attachments;
- `pool.openApp`, `mcpAppSandboxResponse` and `@may/mcp/apps-browser` for browser
  Apps with consent, origin and CSP restrictions;
- `@may/mcp/server` for `createMayMcpServer()` and authenticated, authorized
  tool/resource/prompt exports with an explicit public-result projection.

Native OAuth and an OS-keyring-backed encrypted credential vault are optional.
Legacy interactive operations require an explicit single-operation process or
Session. The server export requires the host to start its listener and choose
exported capabilities. See [MCP tools](../guides/mcp.md),
[Authentication](../guides/mcp-auth.md), [Tasks](../guides/mcp-tasks.md),
[Apps](../guides/mcp-apps.md) and [Server authoring](../guides/mcp-server.md).

## State and policy

### `@may/context`

Replaceable Context factories and compaction strategies include managed in-memory
Context, inspection, automatic compaction, summary-tail, history-reference and
pruning. `@may/context/model-summarizer` provides model-backed summarization.
Context contains the current model-visible view; Session retains durable history.
See [Context and history](../concepts/context-and-history.md).

### `@may/session`

Durable conversation identity and facts include serialized submission and
continuation, event history, cursor-based queries, in-memory storage and branching
through `Session.fork()`. `@may/session/file-store` supplies JSONL storage;
`@may/session/catalog` supplies in-memory and file Catalogs. A Catalog discovers
Sessions; a Session Store reads and appends one Session's records.
See [Configure Session storage](../guides/custom-storage.md) and
[Session, Run and Step](../concepts/session-run-step.md).

### `@may/permissions`

A headless `ToolExecutor` evaluates `PermissionPolicy`, publishes approval
requests and accepts allow/deny decisions. Session grants last within the
configured executor lifetime. `PermissionRuleStore`, `PersistentPermissionRule`
and `InMemoryPermissionRuleStore` support persistent approval rules;
`@may/permissions/file-store` exports `FilePermissionRuleStore`.
The host provides approval UI and any required execution isolation. See
[Permission policy](../guides/permission-policy.md) for scope, expiry and revocation.

### `@may/config`

Loads and validates provider connections, model profiles and application-owned
configuration. `@may/config/schema` exports JSON Schema. The runtime `apps` value
is generic; the bundled editor schema additionally describes MaybeCode settings.
Third-party applications validate their own application section. See
[Configuration reference](configuration.md).

## Models and providers

### `@may/providers`

`ProviderAdapterRegistry` provides instance-owned built-in adapter registration,
configured model selection and capability resolution. Protocol implementations
are also independently consumable:

| Package | Protocol |
| --- | --- |
| `@may/provider-openai` | OpenAI Responses API and native compaction |
| `@may/provider-openai-compatible` | Shared Chat Completions-compatible helpers |
| `@may/provider-anthropic` | Anthropic Messages API |
| `@may/provider-deepseek` | DeepSeek Chat |
| `@may/provider-zhipu` | Zhipu GLM Chat |
| `@may/provider-kimi` | Kimi Chat |

`@may/provider-openai-compatible/http` exports `readSseData` and
`parseRetryAfterMs`. SSE decoding uses `eventsource-parser`, supports LF, CRLF and
CR, and accepts a final event without a blank line at EOF. Aborting or ending
iteration early releases the response body. Retry-After supports seconds,
including decimals, and HTTP dates; the result is milliseconds or `undefined`
when missing or unrecognized.

A Chat Completions chunk with a top-level `error` immediately fails the stream.
Readable server `message`, `type` and `code` fields remain in the visible error;
unreadable error shapes receive an explicit diagnostic. Failed streams omit
`response.completed` and remain failed after `[DONE]` or `finish_reason`.
See [Custom Models](../guides/custom-model.md) and
[Provider compatibility](compatibility.md).

## Tools and media

### `@may/coding-tools`

Workspace-bound read, edit, write and shell tools support coding applications.
Read, edit and write accept a host-owned path-lock `guard` for concurrent
executors. `@may/coding-tools/instructions` exports instruction loading and
`@may/coding-tools/change-preview` exports coding change previews.

`codingRuntimeInstructions()` generates workspace, operating system, shell, Agent
role, Session origin and permission fields. `shellRuntimeInstructions()` provides
shell-specific syntax guidance. Project instructions include their absolute
source path. See [MaybeCode instruction composition](../guides/maybecode-instructions.md).

Shell commands run with the host process's permissions. PowerShell returns
`exitCode: 0` when the final command succeeds. A failed final command preserves the
latest nonzero native exit status, or returns `1` when unavailable. `exit N`
returns `N`. Earlier non-terminating errors remain in `stderr` when a later command
succeeds. See [Custom tools](../guides/custom-tool.md) for permission and isolation
requirements.

### `@may/session-tools`

The bounded, read-only `session_history` tool queries durable Session history.
`AgentApplication` can install it automatically; lower-level hosts can construct
it directly.

### `@may/media`

`imageAttachment()` derives attachment metadata. `displayParts()` projects text
and images and omits reasoning content. `inspectImage()` validates PNG, JPEG,
WebP, GIF and AVIF within 32 MiB and 40 million input pixels. `readEmbeddedImage`
validates base64 content and MIME agreement; URL and file-ID bytes require a
host-provided `MediaReader`.

`FileMediaStore` validates and saves images, verifies saved files and defaults to
`readEmbeddedImage`. `imagePng()` converts a validated image to PNG. See
[Image replies](../guides/images.md) for terminal, Web UI and channel integration.

## UI

### `@may/tui`

Terminal primitives and Agent-aware projections use these import paths:

| Export | Purpose |
| --- | --- |
| `@may/tui` | Components, renderer, editor, focus, scroll and terminal driver |
| `@may/tui/node-terminal` | Line-oriented Node terminal adapter |
| `@may/tui/transcript` | Session/live-event transcript store and retained view |
| `@may/tui/tool-renderers` | Instance-owned tool presentation renderers |
| `@may/tui/slash-commands` | Command parsing and completion state |
| `@may/tui/list-selection` | Filtered list and picker state |

The host application defines product commands, labels, layout and controller
calls. See [Custom UI](../guides/custom-ui.md).

### `@may/ui-client` / `@may/web-ui`

`@may/ui-client` exports the UI-neutral client protocol. Its `/application`,
`/reading`, `/projection` and `/server` subpaths provide application adapters,
reading state, projections and server support. `@may/web-ui` provides browser
workbench components; `/styles.css` and `/assets` expose styles and asset support.
Product adapters preserve their Session/task semantics. See the
[Web UI guide](../guides/web-ui.md),
[UI client README](../../../packages/ui/client/README.md) and
[Web UI README](../../../packages/ui/web/README.md).

### `@may/keybindings`

Maps context-specific key sequences to semantic UI actions. The host owns
terminal rendering and product commands.

## Reference products

All applications in this section are private workspace packages.

| Package | Purpose | Guide |
| --- | --- | --- |
| `@may/maybecode` | Coding Agent, terminal/Web UI host, delegated sub-agents and reviewed team workflows | [MaybeCode](../guides/maybecode.md) |
| `@may/maybeclaw` | Gateway for durable conversations, Agent adapters, event routing and channel delivery | [MaybeClaw](../guides/maybeclaw.md) |
| `@may/cli` | Small application demonstrating direct Core usage | [Getting started](../getting-started.md) |
| `@may/eval-cli` | Trusted-suite evaluation commands, reports, resume and comparison | [Evaluation](../guides/eval.md) |

MaybeCode teams use local Agents and default to read-only. Coding mode edits
private copies; the host reviews and applies patches to source files. Configured
checks require separate authorization and execute with host process permissions.
See [Team coding](../guides/maybecode-team-coding.md).

MaybeClaw's `AgentGateway` composes `PluginHost`, Agent adapters, coordination and
delivery services. Its CLI, authenticated Web UI/control API and Feishu/Telegram
adapters operate on durable Gateway conversations. The private
`@may/maybeclaw/rpc` export supports its RPC host integration.
