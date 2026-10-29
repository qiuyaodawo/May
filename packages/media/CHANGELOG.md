# @sortedyuan/media

## 0.4.0

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

## 0.3.2

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0

## 0.3.0

### Minor Changes

- 749fadc: Coordinate configuration loading and updates, Git checkpoint metadata access, and image verification and replacement across local processes. Concurrent readers no longer prevent these writers from replacing files on Windows.

  **Breaking:** these operations use persistent `.access` and `.access.gate` files beside their data, backed by native operating-system locks from `@sortedyuan/session/file-access`. First access needs directory write permission to create the access files. Keep the files with the data and upgrade all processes sharing that data together. Initialize configuration with `loadMayConfig()` and existing images with `FileMediaStore.verify()` before granting only read permission. For strictly read-only Git metadata access, call `checkpoints()` and `listWorktrees()` once using a manager with `autoCommit: false` and `readOnly: false`; subsequent `readOnly: true` queries require only read permission and create no state files.

### Patch Changes

- Updated dependencies [749fadc]
  - @sortedyuan/session@0.3.0

## 0.2.0

### Minor Changes

- 2a44905: Preserve ordered image replies from OpenAI Responses and expose reusable raster
  attachment validation, storage and reading. Terminal views support Kitty/iTerm2
  graphics and saved-file information; Web UI provides session-scoped authenticated
  image access, viewing and downloads. Hosts can supply custom media readers.
  Existing text-only consumers remain compatible.
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

- e3736f6: 加快 MaybeCode 启动：CLI 使用按功能加载的 JavaScript 打包文件，图片处理和 Web 服务在使用时加载。Git 初始化合并仓库身份与操作状态查询，并在 checkpoint 操作内复用状态结果，保留初始 checkpoint 和写入前检查。
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
