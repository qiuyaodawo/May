# @sortedyuan/mcp

## 0.4.0

### Minor Changes

- 886bfa6: Add defineTool with Standard Schema validation and draft-07 input schema conversion. Validation failures expose field paths through ToolInputValidationError. Tool parsing supports asynchronous validation and preserves null and undefined results across MCP execution.

  Migration: callers invoking tool.parse() directly must await its result. Execution adapters await parsing, check cancellation, and freeze the parsed input before execution.

### Patch Changes

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

- 886bfa6: Keep file-operation cleanup within the caller's operation result. Wait for evaluation process cancellation, MCP subscription and transport cleanup, and delegation request background work before their owners finish closing. Propagate cleanup and delegation cancellation failures to callers.
- 886bfa6: Preserve null and undefined returned by tool parsers when passing input to permission checks and execution in MCP exports and host tool calls.
- Updated dependencies [886bfa6]
- Updated dependencies [9a95d38]
- Updated dependencies [495b234]
- Updated dependencies [886bfa6]
- Updated dependencies [9a95d38]
- Updated dependencies [f3709c4]
- Updated dependencies [886bfa6]
  - @sortedyuan/may@0.2.0
  - @sortedyuan/observability@0.3.1

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

- c23ff33: Provide shared local file access, writer ownership and durable replacement through
  the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
  delivery reuse this storage module. Session's file
  subpaths reexport the same functions and retain shared lock state and behavior.
- Updated dependencies [437b090]
- Updated dependencies [c23ff33]
- Updated dependencies [437b090]
- Updated dependencies [1dd118f]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
  - @sortedyuan/may@0.1.0
  - @sortedyuan/observability@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0

## 0.2.2

### Patch Changes

- 941b411: Coordinate the complete credential lock lifecycle across processes so Windows pending-delete handles cannot interrupt concurrent credential operations. Preserve the existing lock recovery procedure and ten-second acquisition limit.
- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0

## 0.2.1

### Patch Changes

- 749fadc: Coordinate MCP task journal reads with updates across journal instances and processes. Coordinate all encrypted credential record reads, replacements and deletions through the Session file-access helper, including concurrent OAuth status checks and token updates on Windows.

  The credential store creates permanent `.access` and `.access.gate` files beside encrypted records. Upgrade all processes sharing a vault together and preserve these files while the vault is in use.

- Updated dependencies [749fadc]
  - @sortedyuan/session@0.3.0

## 0.2.0

### Minor Changes

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

- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/core@0.2.0
