# @sortedyuan/media

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
