# @sortedyuan/config

## 0.2.0

### Minor Changes

- 02789c6: Add MaybeClaw administrator password configuration with automatic salted hash storage
  and expiring logins. Add an optional Web UI authentication interface for product-owned
  password login and logout, preserving existing token and launcher integrations.
- 02789c6: 允许 `apps.maybeclaw.agents` 为空列表或省略，支持配置管理员密码后启动控制台，并通过 Web 添加首个 Agent。
- 0dc3f68: `may-config.schema.json` 增加 `apps.maybecode.subagents`：委派开关、角色（模型、
  reasoning effort、指令、工具、可委派角色、Run 预算）、并发与深度等限制、子 Agent 的
  `runBudget`，以及一次请求共享的 `maxModelCalls`、`maxTotalTokens` 与
  `reservationTokens`。`false` 或 `{ "enabled": false }` 关闭子 Agent 委派。
  子 Agent 的 `runBudget` 缺省为 24 步、24 次模型调用与 48 次工具调用，一次请求共享的
  `maxModelCalls` 缺省为 128。
- 8df2b63: Add the Node-only application/git-workspace entry point for project Git checkpoints, coordinated request commits, persistent worktree management and reviewed file restoration. Add shared workspace status, reply fork and checkpoint diff data to UI hosts and clients, with keyboard history and diff components for terminal applications.
- 02789c6: Extend the published configuration schema with MaybeClaw Gateway version 2,
  registered May and module Agent adapters, explicit image/audio/file/video capabilities, access controls, channel group settings,
  an explicit HTTPS origin for reverse-proxy access, and lifecycle limits. Version 2 requires an explicit Agent list and configures
  Run budgets per Agent. Existing configurations without a version retain legacy
  validation; migrate them with the MaybeClaw migration workflow before enabling
  the Gateway.
- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
- 02789c6: Expose optional host status badges in UI snapshots and render them in the fixed
  Web UI header, including on narrow screens. Add the MaybeCode permissionMode
  configuration schema for default approvals and opt-in YOLO auto-approval.
  The line-oriented terminal can update an active prompt while preserving its
  input and cursor, allowing connected views to keep status indicators current.

  MaybeCode supports --yolo, --no-yolo and /yolo [on|off|status], preserves explicit
  policy denials, and displays the current mode in terminal and Web UI sessions.
  The bare /yolo command enables the mode; /yolo status reports it without changes.
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

- 02789c6: MaybeClaw 管理员密码的配置 schema 允许至少 10 个字符，与初始化页面和登录校验保持一致。
