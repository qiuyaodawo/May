# @sortedyuan/skills

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
- c8c14c7: Skills 初始提供名称、描述及兼容要求，通过 `skill_read` 按需读取正文与资源；
  保留已激活文档的 Session 持久化行为，并明确指令贡献顺序。

  委派工具描述提供任务说明和等待流程，动态指令提供共享 workspace、角色和请求限制，
  仅在委派工具可用时注入。子 Agent 指令提供文件范围及报告要求。

  新增基础与项目指令来源、运行前刷新及权限模式 callbacks，使子 Session 按顺序接收
  自己的运行环境、项目规则与任务说明。
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
