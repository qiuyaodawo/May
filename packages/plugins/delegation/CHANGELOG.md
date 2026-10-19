# @sortedyuan/plugin-delegation

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/application@0.2.1
  - @sortedyuan/coordination@0.2.1
  - @sortedyuan/plugin-services@0.2.1
  - @sortedyuan/plugin-goals@0.2.1
  - @sortedyuan/plugin-history-memory@0.2.1
  - @sortedyuan/plugin-mcp@0.2.1

## 0.2.0

### Minor Changes

- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
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
- c8c14c7: Skills 初始提供名称、描述及兼容要求，通过 `skill_read` 按需读取正文与资源；
  保留已激活文档的 Session 持久化行为，并明确指令贡献顺序。

  委派工具描述提供任务说明和等待流程，动态指令提供共享 workspace、角色和请求限制，
  仅在委派工具可用时注入。子 Agent 指令提供文件范围及报告要求。

  新增基础与项目指令来源、运行前刷新及权限模式 callbacks，使子 Session 按顺序接收
  自己的运行环境、项目规则与任务说明。
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

- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
- 8df2b63: Allow Goal Run handles to finalize host resources after verification and durable goal-state updates. Finalization receives completed, continued, failed or cancelled outcomes and finishes before another Run begins, enabling final file checkpoints and workspace leases that remain active during verification.

  Allow delegated model calls to share Goal token accounting, budgets and cancellation while retaining their own task instructions. Apply this wrapper to both default and role-specific child models, so delegated work can execute within an active Goal.

  Expose the updated controller through goalsService. Goal cancellation and budget exhaustion cancel the current execution handle, including delegated tools and executions whose handles arrive after cancellation, and await host finalization before finishing.
- Updated dependencies [02789c6]
- Updated dependencies [02789c6]
- Updated dependencies [0dc3f68]
- Updated dependencies [c8c14c7]
- Updated dependencies [0dc3f68]
- Updated dependencies [b3980fd]
- Updated dependencies [0dc3f68]
- Updated dependencies [0dc3f68]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [78bde1d]
- Updated dependencies [02789c6]
- Updated dependencies [8df2b63]
- Updated dependencies [8df2b63]
- Updated dependencies [2a44905]
- Updated dependencies [422e404]
- Updated dependencies [02789c6]
- Updated dependencies [e3736f6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [c8c14c7]
- Updated dependencies [02789c6]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
- Updated dependencies [cefc5e9]
- Updated dependencies [02789c6]
- Updated dependencies [88e7d69]
  - @sortedyuan/config@0.2.0
  - @sortedyuan/application@0.2.0
  - @sortedyuan/coding-tools@0.2.0
  - @sortedyuan/coordination@0.2.0
  - @sortedyuan/session@0.2.0
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/context@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/plugin-goals@0.2.0
  - @sortedyuan/skills@0.2.0
  - @sortedyuan/plugin-history-memory@0.2.0
  - @sortedyuan/permissions@0.2.0
  - @sortedyuan/plugin-services@0.2.0
  - @sortedyuan/plugin-mcp@0.2.0
