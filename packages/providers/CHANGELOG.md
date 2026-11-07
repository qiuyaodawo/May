# @sortedyuan/providers

## 0.4.0

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

- 04c17db: Capability discovery queries the model endpoint of every built-in adapter, using the configured `baseURL` or the adapter's default service address and that adapter's authentication: OpenAI-compatible adapters request `/models`, `anthropic-messages` requests `/v1/models`, and `google-gemini` requests `/models/{model}`. It reads reasoning efforts from `models[]` entries matched by `slug`, `data[]` entries matched by `id`, or a single Gemini model resource, using `supported_reasoning_levels`, `reasoning_levels` or `effort.supported_levels`. Services that publish these fields now report known reasoning efforts without a `capabilities` declaration.

  Behavior changes: connections without `baseURL` now send one discovery request to the default service address, cached for the resolver's TTL. Capability diagnostics name this discovery `model-list` instead of `cpa-codex`. Tests that must stay offline can pass `createModelCapabilityResolver({ discoveries: [] })` or point `baseURL` at a local address.

### Patch Changes

- Updated dependencies [886bfa6]
- Updated dependencies [9a95d38]
- Updated dependencies [495b234]
- Updated dependencies [886bfa6]
- Updated dependencies [9a95d38]
- Updated dependencies [886bfa6]
  - @sortedyuan/may@0.2.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [437b090]
- Updated dependencies [c23ff33]
- Updated dependencies [437b090]
- Updated dependencies [1dd118f]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
  - @sortedyuan/may@0.1.0

## 0.2.3

### Patch Changes

- @sortedyuan/config@0.3.2
  - @sortedyuan/provider-anthropic@0.2.0
  - @sortedyuan/provider-deepseek@0.2.0
  - @sortedyuan/provider-gemini@0.2.0
  - @sortedyuan/provider-kimi@0.2.0
  - @sortedyuan/provider-zhipu@0.2.0

## 0.2.2

### Patch Changes

- Updated dependencies [941b411]
  - @sortedyuan/config@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [749fadc]
  - @sortedyuan/config@0.3.0
  - @sortedyuan/provider-anthropic@0.2.0
  - @sortedyuan/provider-deepseek@0.2.0
  - @sortedyuan/provider-gemini@0.2.0
  - @sortedyuan/provider-kimi@0.2.0
  - @sortedyuan/provider-zhipu@0.2.0

## 0.2.0

### Minor Changes

- ef3b26a: Add the native `google-gemini` adapter with streaming text and reasoning, media content, signed tool-call continuation, JSON/schema validation, cancellation, and Gemini usage accounting that includes reasoning in output and cache hits in input.
- 88e7d69: Add physical model-attempt and first-output telemetry, independently sampled metrics, bounded diagnostics and acceptance records, and official OpenTelemetry/OTLP adapters. Model wrappers can forward attempt observation and safe configuration identity; model-call telemetry shares detailed usage and pricing results with budgets. Bound memory retention, exporter queues, attributes, and lifecycle waits; expose missing data, export failures, and overflow counters.

  Preserve usage and pricing receipts when completed responses fail structured validation or final-event Hooks. Charge known consumption once before Context persistence and completion Hooks, keep failed Run totals visible, and calculate telemetry usage completeness consistently with budgets.

- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.

- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.

### Patch Changes

- 2a44905: Preserve ordered image replies from OpenAI Responses and expose reusable raster
  attachment validation, storage and reading. Terminal views support Kitty/iTerm2
  graphics and saved-file information; Web UI provides session-scoped authenticated
  image access, viewing and downloads. Hosts can supply custom media readers.
  Existing text-only consumers remain compatible.
- Updated dependencies [02789c6]
- Updated dependencies [02789c6]
- Updated dependencies [0dc3f68]
- Updated dependencies [02789c6]
- Updated dependencies [8df2b63]
- Updated dependencies [ef3b26a]
- Updated dependencies [422e404]
- Updated dependencies [02789c6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [2a44905]
- Updated dependencies [02789c6]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [63f68e5]
- Updated dependencies [02789c6]
- Updated dependencies [88e7d69]
  - @sortedyuan/config@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/provider-gemini@0.2.0
  - @sortedyuan/provider-openai@0.2.0
  - @sortedyuan/provider-openai-compatible@0.2.0
  - @sortedyuan/provider-anthropic@0.2.0
  - @sortedyuan/provider-deepseek@0.2.0
  - @sortedyuan/provider-kimi@0.2.0
  - @sortedyuan/provider-zhipu@0.2.0
