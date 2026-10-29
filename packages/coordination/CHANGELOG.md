# @sortedyuan/coordination

## 0.5.0

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
- c23ff33: Add durable continuation identities and public Session outcome queries. Attached
  coordination agents preserve each continuation identity across cancellation and
  restart, and record their recovery protocol with dispatch. Existing dispatched
  continuations without identity require a verified recovery finding. Hosts wrapping
  coordination adapters must forward their optional recoveryVersion property.

  Preserve the complete Model interface through Goal wrappers, including dynamic
  capabilities and preflight validation before model-call accounting. Locally rejected
  requests keep known usage and produce no physical-attempt record.

### Patch Changes

- 437b090: Reject pending Session continuations after runtime closure. Preserve active
  conversation ownership when concurrent adapter calls target the same Session.
  Attached coordination runs enforce both coordinator and host budgets and recover
  later turns using the host's stable initial input identity.
- c23ff33: Provide shared local file access, writer ownership and durable replacement through
  the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
  delivery reuse this storage module. Session's file
  subpaths reexport the same functions and retain shared lock state and behavior.
- c23ff33: Expose structural contribution registries and separate Application execution,
  history and state service interfaces. Application service views preserve identity
  through plugin replacement and reject access before creation or after closure.

  **Breaking:** `ApplicationAccess.get()` and `GoalsPluginOptions.createAgent` now
  expose `ApplicationFacade`. Type plugin integrations against the required service
  interfaces. Application closing, plugin updates and skill activation belong to
  the host. `services.toolSources.snapshot()` returns `Iterable<Tool>`; consumers
  that need catalog methods can construct a `ToolRegistry` from that iterable.
- Updated dependencies [437b090]
- Updated dependencies [c23ff33]
- Updated dependencies [437b090]
- Updated dependencies [1dd118f]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
  - @sortedyuan/may@0.1.0
  - @sortedyuan/mcp@0.3.0
  - @sortedyuan/coding-tools@0.3.0

## 0.4.0

### Minor Changes

- 将组件插件工厂、Coordination 插件和 Session 历史工具集中到所属包的公开子路径。
  Application 与 MaybeCode 使用新的导入及运行时依赖。公开发布范围为 38 个包。

  这是包路径的破坏性变更。使用方需要更新依赖声明、源码导入及加载这些模块的配置：

  | 原包 | 公开子路径 | 需要安装的包 |
  | --- | --- | --- |
  | `@sortedyuan/plugin-models` | `@sortedyuan/plugin-services/models` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-runtime` | `@sortedyuan/plugin-services/runtime` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-permissions` | `@sortedyuan/plugin-services/permissions` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-skills` | `@sortedyuan/plugin-services/skills` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
  | `@sortedyuan/session-tools` | `@sortedyuan/session/tools` | `@sortedyuan/session` |

  选择包含这些子路径的发布版本，重新安装依赖并编译使用方。六个原包从本仓库的发布清单移除。
  插件 ID、ServiceToken ID、持久状态格式、函数名称及生命周期行为保持不变。
  迁移说明见 `docs/zh-CN/guides/package-subpaths.md` 和 `docs/en/guides/package-subpaths.md`。

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0
  - @sortedyuan/application@0.3.2

## 0.3.1

### Patch Changes

- 941b411: Coordinate writer-lock creation and deletion for coordination journals, resource journals and remote workers across processes. Preserve owner files after process termination. Upgrade all processes sharing a data directory together and retain `.lock.access` and `.lock.access.gate` during use and recovery.
- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0
  - @sortedyuan/application@0.3.1

## 0.3.0

### Minor Changes

- 749fadc: Coordinate journal inspection with appends, tail repair and checkpoint replacement across processes, preserving complete snapshots during concurrent reads and writes on Windows.

  Breaking change: each journal now keeps permanent `.access` and `.access.gate` files. The first open or inspection requires directory write permission to create them. For existing data, stop the hosts, upgrade all processes sharing the directory, and run an inspection with directory write permission before assigning read-only access to monitors. Keep the access files readable to monitors and preserve them while any reader or writer is active.

### Patch Changes

- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
  - @sortedyuan/application@0.3.0
  - @sortedyuan/session@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/application@0.2.1

## 0.2.0

### Minor Changes

- 0dc3f68: 新增宿主已经持有 Session 的任务适配器 `createAttachedApplicationAgent`：
  宿主提供 Session 所有者与每轮的 submit 选项，agent 负责输入身份、让出边界与任务
  取消信号，并且拒绝第二个执行方并发认领同一个 Session，也不打开或关闭宿主的
  application。`CreateCoordinationOptions.sessionIds` 允许根任务直接使用宿主已有的
  Session。`TaskSpec.files` 声明任务可以修改的工作区相对文件，委派工具接受并校验
  该字段。`delegationTool`（导出为 `createDelegationTool`）新增 `agents`、
  `guidance` 与 `maxInputBytes` 选项，使描述与限制由宿主决定。
  `FileSharedBudget` 新增 `reserveCall`、`settleCall`、`markCallUnknown` 与
  `runExternal`，供宿主在模型调用之外（例如 provider 原生上下文压缩）预留并计账。
  `runExternal(id, reservation, operation)` 按结果中的 provider usage 结账；结果没有
  usage 时按预留值保守计账，并在账本中把该次调用标记为 `estimated`。
  `SharedBudgetTotals` 新增 `usageComplete`：只有每次调用都按 provider 上报的 usage
  结账时它才为 `true`，因此估计值不会被当成完整统计。
  `sharedBudgetTotals` 在账本没有配置 `maxTotalTokens` 或 `maxCostUsd` 时不再因为单次
  调用超出预留值而阻塞，调用次数上限仍然生效。
  `validateTaskFiles` 导出用于校验文件声明。
  `createApplicationAgent` 新增 `onOpen` 回调，允许宿主在提交任务前将独立的会话状态绑定到
  刚打开的 application。
  `resolveRecovery` 允许宿主在 runtime 尚未启动且没有活动任务时，为 queued 或 waiting
  任务记录经过核对的终态，支持中断请求的人工处理。任务尚未提交输入就失败时保留原始错误信息。
- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
- 02789c6: Export `coordinationInput` and `createCoordinationTools` so hosts can compose the existing delegation, messaging, and handoff workflow with their own persistent Agent conversations. Export `validateCoordinationSnapshot` for validating durable state before host-specific recovery decisions. Recovery now recognizes cancelled permission requests as evidence that the corresponding tool did not start.
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.
- 88e7d69: 扩展 Usage 的缓存、reasoning、其他计量、包含关系、完整性与 provider 金额；提供版本化
  价格配置和可替换的计价接口。RunBudget、FileSharedBudget 与遥测使用同一计价结果，
  费用记录保留币种、来源、版本和完整性。保留现有输入输出 USD 单价配置，USD 预算需要
  完整的 USD 计价。OpenAI、兼容 provider 与 Anthropic adapter 保存 provider 计量明细。
  共享预算包装透传模型执行前验证，验证过程不消耗预留额度。包装模型动态提供最新的
  能力版本、配置和限制，保留能力发现与刷新产生的更新。
  已完成响应的 schema 验证失败时保留已知用量并结算一次，错误继续携带已计算费用供
  外层预算使用。`settleCall()` 支持可选的已计算费用。计价异常保留已知 token 统计并
  将费用完整性标记为 false；响应拒绝和计账失败的原因都会保留。

### Patch Changes

- 1e9bdfc: 修复 Session 文件对 `input.generated` 的读取校验，使 Hook 追加的继续执行消息和分支继承的已交付补充输入能够恢复。

  Plugin replacement 等待已接受的状态更新完成保存，并在替换准备期间拒绝新的状态写入。

  ContextController 新增可选的 `commitCompaction(result)`，用于标记替换后的 Context 已经成功保存。AgentApplication 在保存成功后调用该方法；完成 Hook 的错误继续传递，活动 Context 和持久化记录保持一致。

  Remote CoordinationWorker 将已保存的取消意图发送给分离的外部执行，并通过恢复查询确认结果。

  PowerShell shell 工具根据最后执行命令的状态返回 exitCode，失败的 cmdlet 返回非零值。
- 78bde1d: `BatchSpanProcessor` 在 exporter 同步抛出错误后能够完成 `forceFlush()` 和 `shutdown()`，
  并继续导出后续批次。重复调用 `TaskWorkspaceManager.prepare()` 保留目录校验，
  不再追加相同的 workspace 状态记录。
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
- Updated dependencies [0dc3f68]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [8df2b63]
- Updated dependencies [2a44905]
- Updated dependencies [422e404]
- Updated dependencies [e3736f6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/application@0.2.0
  - @sortedyuan/session@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/permissions@0.2.0
