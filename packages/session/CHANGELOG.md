# @sortedyuan/session

## 0.4.0

### Minor Changes

- 941b411: Add configurable acquisition timeouts and AbortSignal cancellation to `withFileAccess`, with ownership retained until an active callback settles.

### Patch Changes

- 941b411: Coordinate writer-lock creation and deletion with permanent access markers across processes, covering coordination journals, resource journals, remote workers, configuration updates, Team verification and patch application. Preserve owner files after process termination and close owned handles when release cannot obtain file access. Upgrade all processes sharing a data directory together and retain the access markers during recovery.

## 0.3.0

### Minor Changes

- 749fadc: Add `@sortedyuan/session/file-access` with native shared and exclusive locks for cooperating local processes. Writers wait for active readers before replacing files, access releases when a process exits, and read-only callers can require preinitialized persistent access markers. Access acquisition has a 30-second timeout and rejects recursive access to the same file.

## 0.2.0

### Minor Changes

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
- 78bde1d: 保存工具执行时的模型可见 `content`，在 Session 恢复及历史工具查询时使用该内容。
  host 历史接口继续保留原始 `output`。`@sortedyuan/session` 提供 `sessionToolResultContent`。

  Breaking change（0.x minor）：自行构造 Core `tool.completed` 事件的调用方必须提供 `content`，
  其值应当来自工具执行后生成的 `ToolMessage.content`。自定义 Session 存储应保留此字段。
  已有记录缺少 `content` 时，模型收到内容不可用提示；需要恢复具体内容的 host 应根据
  可信的历史记录补充模型可见内容。工具不会自动重新执行。
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
- 0dc3f68: `SessionStore` 新增可选的 `directory` 字段。持久化存储返回自己的目录，内存存储为
  `undefined`，宿主可以用它选择同一目录树下的记录位置，例如按请求保存协调记录与
  额度账本。既有实现无需修改。
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
