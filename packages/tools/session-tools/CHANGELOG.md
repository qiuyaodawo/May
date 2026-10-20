# @sortedyuan/session-tools

## 0.2.1

### Patch Changes

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

- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
- 78bde1d: 保存工具执行时的模型可见 `content`，在 Session 恢复及历史工具查询时使用该内容。
  host 历史接口继续保留原始 `output`。`@sortedyuan/session` 提供 `sessionToolResultContent`。

  Breaking change（0.x minor）：自行构造 Core `tool.completed` 事件的调用方必须提供 `content`，
  其值应当来自工具执行后生成的 `ToolMessage.content`。自定义 Session 存储应保留此字段。
  已有记录缺少 `content` 时，模型收到内容不可用提示；需要恢复具体内容的 host 应根据
  可信的历史记录补充模型可见内容。工具不会自动重新执行。
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/session@0.2.0
  - @sortedyuan/core@0.2.0
