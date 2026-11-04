---
"@sortedyuan/may": minor
"@sortedyuan/providers": minor
"@sortedyuan/coordination": minor
"@sortedyuan/maybecode": minor
"@sortedyuan/mcp": patch
"@sortedyuan/web-ui": patch
---

Consolidate shared infrastructure and let each application own its configuration schema.

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
