# @sortedyuan/may

## 0.2.0

### Minor Changes

- 886bfa6: Add Anthropic automatic prompt caching with configurable TTL and instruction cache breakpoints. Provider and model options support promptCaching, including false to disable caching. MaybeCode enables five-minute caching and instruction breakpoints by default for Anthropic models.
- 9a95d38: Consolidate shared infrastructure and let each application own its configuration schema.

  `@sortedyuan/may`:

  - Breaking: `may-config.schema.json` describes only `providers`, `models` and `defaultModel`; `apps` entries are plain objects validated by their applications. `parseMayConfig` validates the whole file against this schema, so adapter-specific provider options that the schema does not list are rejected. Use a custom adapter name for adapter options outside the built-in list.
  - New: `createApplicationConfigSchema(id, section, title)` composes an application section with the core schema, and `createApplicationConfigValidator(id, section)` validates `apps.<id>`; both report `MayConfigValidationError` with the failing field path.
  - Breaking: `acquireFileLock` uses an operating-system lock that the process exit releases; `recoverFileLock` is removed. Import file locking and access helpers from `@sortedyuan/may/storage`; the `./session/file-access` export is removed.
  - Breaking: `AgentController.listRecoveries()` is required. `AgentWorkspace.workspace` returns the workspace of the selected session without reading it from the application.
  - New exports: `omitUndefined`, `AsyncStateSerializer`, `hasErrorCode` and atomic file writing based on `write-file-atomic`.
  - Session record writes now reject the request or Run that triggered them instead of being dropped.

  `@sortedyuan/providers`:

  - Breaking: DeepSeek, Kimi and Zhipu models share `OpenAICompatibleChatModel`. Their provider-specific error classes are replaced by `OpenAICompatibleApiError`, `OpenAICompatibleProtocolError` and `OpenAICompatibleFinishReasonError` with a `provider` field. Migrate checks such as `error instanceof DeepSeekApiError` to `error instanceof OpenAICompatibleApiError && error.provider === "DeepSeek"`.

  `@sortedyuan/coordination`:

  - Breaking: `resolveSubagentConfiguration` accepts the validated `apps.maybecode.subagents` value instead of the whole configuration. `SubagentHostOptions` requires `requestRecording` and `providerBodyRecording`, and child Sessions use them; `createDelegationPlugin` accepts both options.

  `@sortedyuan/maybecode`:

  - Breaking: the package exports only `runMaybeCode`, `openConfiguredMaybeCode`, `MaybeCodeController` with its event types, and `MaybeCodeUsageError`.
  - Breaking: `MaybeCodeController` exposes the active `application` and `transition()` for queued state changes; read-only forwarders such as `getGoal()`, `modelInfo`, `instructions`, `listSkills()` and the delegation readers move to `controller.application`.
  - Breaking: the classic terminal UI and `--ui classic` are removed; `retained` is the default and `web` remains available.
  - Breaking: deprecated options are removed; use `autoCompaction.mode: "provider-native"`.
  - `apps.maybecode` is validated by the schema exported as `@sortedyuan/maybecode/config/schema`; invalid values report `MayConfigValidationError` with the field path.
  - Team runs and sub-agents follow `apps.maybecode.requestRecording` and `providerBodyRecording`.

  `@sortedyuan/mcp` uses the shared atomic file writing and credential locking. `@sortedyuan/web-ui` shows an error when submitting an approval fails.

- 495b234: Add default-on durable logical model request recording. Sessions retain effective messages,
  tool definitions, provider request bodies and individual attempt outcomes, with
  content reuse and read-only history queries. Built-in providers, retry wrappers,
  application summaries and native OpenAI compaction support awaited recording
  before network execution. MaybeCode exposes requestRecording configuration and
  the WebUI displays saved model requests in record details. Budget wrappers
  preserve request-recording capability.

  New request-history event types require a reader supporting this release.
  Existing histories remain readable; logical recording defaults to required. Provider bodies
  require the independent providerBodyRecording option. Request definitions and references
  are saved in batches before dispatch. Breaking change: custom runtimes
  and adapters must explicitly implement the recording capability before enabling
  required mode, or explicitly select requestRecording: "off" when migrating.
  Authentication remains separate from saved request content.

- 9a95d38: MaybeCode keeps a newly created Session on exit when it holds a goal, so a goal that was started or paused before its first Run can be resumed later. `@sortedyuan/may/goals` exports `GOAL_STATE_KEY`, the Session state key that stores the current goal.
- 886bfa6: Add defineTool with Standard Schema validation and draft-07 input schema conversion. Validation failures expose field paths through ToolInputValidationError. Tool parsing supports asynchronous validation and preserves null and undefined results across MCP execution.

  Migration: callers invoking tool.parse() directly must await its result. Execution adapters await parsing, check cancellation, and freeze the parsed input before execution.

### Patch Changes

- 886bfa6: Keep file-operation cleanup within the caller's operation result. Wait for evaluation process cancellation, MCP subscription and transport cleanup, and delegation request background work before their owners finish closing. Propagate cleanup and delegation cancellation failures to callers.

## 0.1.0

### Minor Changes

- 437b090: Consolidate the framework into `@sortedyuan/may`, including Core, Application,
  Session, Context, permissions, configuration, storage, Skills, plugin hosting,
  services, goals and history memory. Provider implementations use subpaths of
  `@sortedyuan/providers`. Gateway adapters, RPC, delivery and HTTP services use
  `@sortedyuan/gateway`. Capability plugins use their owning package's public
  subpaths; TUI includes keybindings. Update all consumers to use the same framework
  module identities and runtime dependency chain.

  **Breaking:** Replace component dependencies and imports using
  `docs/en/guides/package-subpaths.md` or `docs/zh-CN/guides/package-subpaths.md`.
  Install `@sortedyuan/may` for framework imports such as
  `@sortedyuan/may/session/file-store`; install `@sortedyuan/providers` for protocol
  imports such as `@sortedyuan/providers/deepseek`. Rebuild applications and third-party
  plugins together. Preserve plugin IDs, service IDs, configuration data and saved
  Session state. MaybeCode carries the consolidated dependencies in its published
  installation; its command names remain unchanged.

- c23ff33: Add durable continuation identities and public Session outcome queries. Attached
  coordination agents preserve each continuation identity across cancellation and
  restart, and record their recovery protocol with dispatch. Existing dispatched
  continuations without identity require a verified recovery finding. Hosts wrapping
  coordination adapters must forward their optional recoveryVersion property.

  Preserve the complete Model interface through Goal wrappers, including dynamic
  capabilities and preflight validation before model-call accounting. Locally rejected
  requests keep known usage and produce no physical-attempt record.

- 1dd118f: Add English first-run setup to MaybeCode when its configuration file is missing in an interactive terminal. Guide users through provider, credentials, model settings, optional live connection verification, and saving before continuing into the selected UI. Preserve existing configuration files and report noninteractive setup instructions.

  Add password input to `TerminalIO.question` with hidden characters and isolated input history in interactive terminals.

  Add `createMayConfig` for validated, coordinated creation of complete configuration files without replacing an existing destination. Publishing requires storage with hard-link support.

- c23ff33: Provide shared local file access, writer ownership and durable replacement through
  the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
  delivery reuse this storage module. Session's file
  subpaths reexport the same functions and retain shared lock state and behavior.
- c23ff33: Add shared Session transcript reading for user input, recovery findings, and delivered steering. Web history, search, full-field reads, and retained TUI history preserve these messages and execution outcomes consistently.

  Breaking: TUI tool items now include denied, not-started, and unknown statuses, and assistant items include interrupted. Update exhaustive custom renderers to handle these states.

  Validate ApplicationUiHost commands directly from current execution and ownership state. Presentation reads leave commands available, and host shutdown settles accepted work while rejecting later commands.

- c23ff33: Expose structural contribution registries and separate Application execution,
  history and state service interfaces. Application service views preserve identity
  through plugin replacement and reject access before creation or after closure.

  **Breaking:** `ApplicationAccess.get()` and `GoalsPluginOptions.createAgent` now
  expose `ApplicationFacade`. Type plugin integrations against the required service
  interfaces. Application closing, plugin updates and skill activation belong to
  the host. `services.toolSources.snapshot()` returns `Iterable<Tool>`; consumers
  that need catalog methods can construct a `ToolRegistry` from that iterable.

### Patch Changes

- 437b090: Reject pending Session continuations after runtime closure. Preserve active
  conversation ownership when concurrent adapter calls target the same Session.
  Attached coordination runs enforce both coordinator and host budgets and recover
  later turns using the host's stable initial input identity.
