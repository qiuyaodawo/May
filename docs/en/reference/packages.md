# Package reference

**English** | [简体中文](../../zh-CN/reference/packages.md)

May is a pnpm workspace. Reusable framework code is defined under
`packages/`; executable products live in `apps/`. Applications may depend on
packages, but packages must not import an application.

All packages are currently versioned `0.1.0`. Read
[Compatibility and stability](compatibility.md) before treating a public
surface or persistence format as stable.

## Choose the smallest useful layer

| Goal | Start with | Usually add |
| --- | --- | --- |
| Run one model/tool loop in memory | `@may/core` | A provider adapter |
| Build a headless, durable single-session Agent | `@may/application` | `@may/session`, `@may/context`, permissions and tools |
| Manage multiple sessions in one workspace | `@may/application` | A `SessionCatalog` from `@may/session/catalog` |
| Build a terminal Agent | Headless application controller | `@may/tui`, optionally `@may/keybindings` |
| Build a coding Agent | Headless application controller | `@may/coding-tools` and an execution isolation policy |
| Select models from May configuration | `@may/config` | `@may/providers` |
| Let the model inspect durable history | `@may/session-tools` | An active `Session` or `AgentApplication` |

`@may/core` is appropriate when the caller wants to own the complete runtime
lifecycle. `@may/application` is the normal starting point for an application
that needs sessions, approvals, context management and orderly shutdown.

## Runtime and application

### `@may/core`

The provider-neutral execution kernel:

- `May`, `Model`, `Tool`, `Context` and `ToolExecutor` contracts;
- Run and Step execution, streaming events and cancellation;
- tool scheduling and normalized messages;
- `InMemoryContext` for small or ephemeral integrations.

Core deliberately does not own durable sessions, provider selection, product
configuration, permission policy or UI. See the
[Core package README](../../../packages/core/README.md).

### `@may/application`

Headless orchestration above Core:

- `AgentApplication` owns one active durable Session;
- `AgentWorkspace` owns active-session selection and Catalog updates;
- `AgentController` and `AgentWorkspaceController` define UI-independent
  control surfaces;
- `AsyncStateSerializer` serializes product and session transitions;
- context inspection and compaction results are persisted through Session;
- optional `session_history` and tool-presentation support.

Models, tools, prompts, policies and storage remain injected product choices.
See [Agent and Application](../concepts/agent-application.md) and the
[package README](../../../packages/application/README.md).

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

## Tools

### `@may/coding-tools`

Workspace-bound read, edit, write and shell tools, plus reusable instruction
loading and coding change previews. Subpath exports are:

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

### `@may/keybindings`

Maps context-specific key sequences to semantic UI actions. It is optional and
does not own terminal rendering or product commands.

## Reference products

`@may/maybecode` is the primary coding-Agent application and integration
example. It consumes the packages above but is not a prerequisite for using
them. The smaller `@may/cli` demonstrates direct Core usage.

Continue with [Getting started](../getting-started.md) or
[Building an Agent](../guides/building-an-agent.md).
