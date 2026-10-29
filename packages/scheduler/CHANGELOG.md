# @sortedyuan/scheduler

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

## 0.2.0

### Minor Changes

- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
- 6cec20c: Add opt-in persistent time and event scheduling with timezone-aware cron rules, atomic event deduplication, immutable execution snapshots, restart-safe task submissions, and an exclusive SQLite store. Hosts explicitly start scheduling and provide idempotent task dispatchers.
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
