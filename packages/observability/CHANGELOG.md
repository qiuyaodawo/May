# @sortedyuan/observability

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

## 0.2.1

### Patch Changes

- 92fc3b9: Wait for active OTLP HTTP exports and their diagnostic updates during forceFlush, within the lifecycle timeout.

  Count unfinished exports as failed at the lifecycle deadline and prevent delayed callbacks from counting the same failure twice.

## 0.2.0

### Minor Changes

- 88e7d69: Add physical model-attempt and first-output telemetry, independently sampled metrics, bounded diagnostics and acceptance records, and official OpenTelemetry/OTLP adapters. Model wrappers can forward attempt observation and safe configuration identity; model-call telemetry shares detailed usage and pricing results with budgets. Bound memory retention, exporter queues, attributes, and lifecycle waits; expose missing data, export failures, and overflow counters.

  Preserve usage and pricing receipts when completed responses fail structured validation or final-event Hooks. Charge known consumption once before Context persistence and completion Hooks, keep failed Run totals visible, and calculate telemetry usage completeness consistently with budgets.
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

- 78bde1d: `BatchSpanProcessor` 在 exporter 同步抛出错误后能够完成 `forceFlush()` 和 `shutdown()`，
  并继续导出后续批次。重复调用 `TaskWorkspaceManager.prepare()` 保留目录校验，
  不再追加相同的 workspace 状态记录。
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
