# @sortedyuan/plugin-skills

## 0.2.0

### Minor Changes

- 89bcd8d: Expose existing Agent functionality as reusable plugins with declared services,
  dependencies and managed resource lifecycles. Add shared typed service tokens and
  ordered tool, instruction, Model and Context contribution registries. Application
  direct options compose through plugin factories, and replacement services receive
  creation notifications for the active Application.

  Add plugin factories for runtime, Model, permissions, Skills, goals, historical
  Context, delegation, MCP, observability, durable delivery, Agent
  adapters, task coordination and HTTP listeners. MaybeCode and MaybeClaw use these
  factories for their application and workspace lifecycles. Existing direct APIs and
  application exports remain available. Configuration-selected providers replace
  product defaults by declared service or plugin identity.
  MCP commands, events and delegated Agent tools use the active service provider;
  Application-owned pools follow Session lifecycles and configured shared pools
  follow the workspace lifecycle.

  PluginContext exposes pluginOrder for deterministic contribution ordering.
  Model plugins may provide modelInfo for metadata and model presentation; configured
  applications derive Context budgets from the selected Model service.
  Breaking change: reserved `may.model.provider`, `may.model.name`,
  `may.model.adapter` and `may.model.profile` trace attributes are populated only
  from the active `modelInfo` service. Supply `createModelPlugin({ create, info })`
  to record these fields. Other caller-defined trace attributes remain supported.
  Lifecycle notifications reach Session plugins and their ancestor handlers.
  Adapter release removes cached instances; coordination release relinquishes
  runtime resources. HTTP shutdown drains requests and closes connections before
  disposing product services. Packaged consumers can install each public plugin's
  complete runtime dependency chain independently of the repository.
  The public RPC file Agent example serializes state reads and writes, supports
  concurrent steering and cancellation, and preserves saved inputs after restart.

  Skills state is saved through versioned plugin state while existing Session
  activation records remain readable. Goals and history-memory retain their existing
  durable state records for migration.
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

- c8c14c7: Skills 初始提供名称、描述及兼容要求，通过 `skill_read` 按需读取正文与资源；
  保留已激活文档的 Session 持久化行为，并明确指令贡献顺序。

  委派工具描述提供任务说明和等待流程，动态指令提供共享 workspace、角色和请求限制，
  仅在委派工具可用时注入。子 Agent 指令提供文件范围及报告要求。

  新增基础与项目指令来源、运行前刷新及权限模式 callbacks，使子 Session 按顺序接收
  自己的运行环境、项目规则与任务说明。
- Updated dependencies [1e9bdfc]
- Updated dependencies [422e404]
- Updated dependencies [89bcd8d]
- Updated dependencies [89bcd8d]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/skills@0.2.0
  - @sortedyuan/plugin-services@0.2.0
