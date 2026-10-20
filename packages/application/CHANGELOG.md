# @sortedyuan/application

## 0.3.0

### Minor Changes

- 749fadc: Coordinate configuration loading and updates, Git checkpoint metadata access, and image verification and replacement across local processes. Concurrent readers no longer prevent these writers from replacing files on Windows.

  **Breaking:** these operations use persistent `.access` and `.access.gate` files beside their data, backed by native operating-system locks from `@sortedyuan/session/file-access`. First access needs directory write permission to create the access files. Keep the files with the data and upgrade all processes sharing that data together. Initialize configuration with `loadMayConfig()` and existing images with `FileMediaStore.verify()` before granting only read permission. For strictly read-only Git metadata access, call `checkpoints()` and `listWorktrees()` once using a manager with `autoCommit: false` and `readOnly: false`; subsequent `readOnly: true` queries require only read permission and create no state files.

### Patch Changes

- Updated dependencies [749fadc]
  - @sortedyuan/session@0.3.0
  - @sortedyuan/plugin-services@0.2.2
  - @sortedyuan/session-tools@0.2.1
  - @sortedyuan/plugin-models@0.2.2
  - @sortedyuan/plugin-permissions@0.2.2
  - @sortedyuan/plugin-runtime@0.2.2
  - @sortedyuan/plugin-skills@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/plugin-services@0.2.1
  - @sortedyuan/plugin-permissions@0.2.1
  - @sortedyuan/plugin-models@0.2.1
  - @sortedyuan/plugin-runtime@0.2.1
  - @sortedyuan/plugin-skills@0.2.1

## 0.2.0

### Minor Changes

- 0dc3f68: `AgentController` 与 `AgentWorkspaceController` 新增可选的 `Run` 类型参数，
  `AgentWorkspace` 的类型参数顺序相应调整（`Run` 位于 `Application` 之前）。
  产品可以把自己附加在 Run 上的字段（例如请求身份）声明为更具体的类型，
  `AgentWorkspace` 返回的 Run 会保留这些字段。默认值仍然是非特化的 `AgentRun`，
  未显式填写 `Application` 类型参数的调用无需修改。

  破坏性类型变更：使用原第四个类型参数指定 `Application` 的调用，需要在它之前增加
  `AgentRun`（或应用自己的 Run 类型），例如
  `AgentWorkspace<Event, Extension, Compaction, AgentRun, Application>`。
  `AgentWorkspace.open` 的显式类型参数采用相同顺序。
- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
- 8df2b63: Add durable Session branches at complete request boundaries, preserving the selected Context, runtime state and explicitly transferable application state. Expose branch history trees and workspace-family lifecycle APIs while creating independent permissions and input queues for each branch.

  Hosts can explicitly confirm a scheduler-yielded Run as completed after validation and final state persistence, saving a durable host-confirmed branch boundary.
- 02789c6: Add durable FIFO steering input at complete Step boundaries. AgentApplication and
  Session expose steering status and explicit follow-up execution without
  interrupting current tools or approvals. Preserve delivery identities through
  restart, retain cancelled inputs for explicit resubmission, and keep host yield
  and Run budgets in effect. Add explicit cancellation of pending and idle inputs
  so hosts can stop queued work together with the current execution.

  Session and AgentApplication reserve Step input for their durable steering queue.
  Their submission and continuation options reject custom stepInputSource values
  before execution. Use steer() for durable input; direct May execution retains
  the custom-source API.
  Keep GoalAgent compatible with Session-backed applications by excluding custom
  Step sources from the options passed by the goal scheduler.
- 8df2b63: Add the Node-only application/git-workspace entry point for project Git checkpoints, coordinated request commits, persistent worktree management and reviewed file restoration. Add shared workspace status, reply fork and checkpoint diff data to UI hosts and clients, with keyboard history and diff components for terminal applications.
- 2a44905: Add independently composed durable goal execution, continuation with optional budgets, model tools,
  usage accounting and recovery. Expose general AgentApplication.continue() without
  adding a dependency on goal execution to base Agent packages.

  MaybeCode integrates /goal start, status, pause, resume and cancel in its terminal
  and Web interfaces, retaining the existing permission policy and session storage.

  Run count and active execution time have no default limits. Explicit budgets remain
  enforced and previously saved budgets retain their values. Breaking SDK type change:
  GoalState.budget.maxRuns and maxDurationMs are optional; SDK consumers must handle
  undefined values as unlimited budgets.
- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
- 5d3b04a: Add opt-in persistent allow and deny rules with trusted scope, tool-definition
  binding, creator identity, expiry and revocation. Provide a versioned file store
  with atomic replacement and a single writer lock through
  `@sortedyuan/permissions/file-store`. Rule storage and event persistence failures stop
  tool execution. Explicit denials take precedence, and `requireApproval` requests
  always require a fresh decision.

  Expose trusted rule management and persistent approval resolution through
  Application and Workspace controllers. Persist rule events in Session history
  without adding them to model context. Add persistent approval ranges and rule
  management controls to terminal and Web UI components, with host-owned creator
  identity. Agent adapters accept trusted execution scopes and persistent approval
  metadata. Export workspace path checks for host permission policies.

  Provide `beforeCheck` for one-time execution preparation from immutable inputs,
  and keep Application tool previews separate from repeated permission evaluations.

  Add `apps.maybecode.persistentRules` and `apps.maybeclaw.persistentRules` to the
  configuration schema. Both default to false. MaybeCode stores project rules in
  `.may/permission-rules.json`; MaybeClaw stores them in its data directory and
  restricts management to operators.

  Compatibility: the public `ApprovalDecision`, `PermissionEvent` and
  `SessionEvent` unions gain variants. Exhaustive TypeScript consumers must add
  `allow-persistent` and `rule.created` / `rule.revoked` / `rule.used` handling.
  Access `requestId` only after narrowing to `approval.resolved` or
  `approval.cancelled`, and offer persistent approval only when request metadata
  exists. Supply a trusted `createdBy` identity when resolving it. Existing policy
  return values and existing Session histories remain supported. Readers of
  histories containing rule events must use the updated Session package.
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
- 89bcd8d: Add scoped plugin composition with typed versioned services, validated dependencies,
  configuration and state schemas, lifecycle Hooks, state migration, resource cleanup
  and serialized replacement. Agent definitions and applications accept plugins;
  MaybeCode and MaybeClaw can load plugin definitions from configuration.

  Expose replaceable AgentRuntime factories and runtime state persistence through
  Session. The default May runtime retains the existing direct API and integrates
  ordered Hooks around input, runs, steps, Context, models, tools, approvals and
  recovery. Durable records retain raw tool output and generated continuation inputs.

  Runtime identity and state versions are recorded in new Sessions. Existing May
  histories remain readable; resuming with an incompatible custom runtime requires
  an explicit migration. Plugin replacement waits for active operations, and failed
  replacement initialization prevents further execution until composition is repaired.

  Breaking change: validated tool argument objects and permission input snapshots
  are recursively frozen. Tools and policies must treat arguments as read-only.
  Mutable built-in containers such as Date, Map and Set are rejected at the tool
  argument boundary; use ordinary data objects and arrays to represent those values.
  Custom parsed instances retain their prototypes and methods and must protect any
  mutable internal state themselves.
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

- 1e9bdfc: 修复 Session 文件对 `input.generated` 的读取校验，使 Hook 追加的继续执行消息和分支继承的已交付补充输入能够恢复。

  Plugin replacement 等待已接受的状态更新完成保存，并在替换准备期间拒绝新的状态写入。

  ContextController 新增可选的 `commitCompaction(result)`，用于标记替换后的 Context 已经成功保存。AgentApplication 在保存成功后调用该方法；完成 Hook 的错误继续传递，活动 Context 和持久化记录保持一致。

  Remote CoordinationWorker 将已保存的取消意图发送给分离的外部执行，并通过恢复查询确认结果。

  PowerShell shell 工具根据最后执行命令的状态返回 exitCode，失败的 cmdlet 返回非零值。
- c8c14c7: 组装的动态提示词发生变化时，使对应 Context 的 provider token 计量失效，后续检查
  根据当前提示词估计用量，直到 provider 提供新的 usage。
- e3736f6: 加快 MaybeCode 启动：CLI 使用按功能加载的 JavaScript 打包文件，图片处理和 Web 服务在使用时加载。Git 初始化合并仓库身份与操作状态查询，并在 checkpoint 操作内复用状态结果，保留初始 checkpoint 和写入前检查。
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/session@0.2.0
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/context@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/session-tools@0.2.0
  - @sortedyuan/skills@0.2.0
  - @sortedyuan/permissions@0.2.0
  - @sortedyuan/plugin-services@0.2.0
  - @sortedyuan/plugin-runtime@0.2.0
  - @sortedyuan/plugin-models@0.2.0
  - @sortedyuan/plugin-permissions@0.2.0
  - @sortedyuan/plugin-skills@0.2.0
