# @sortedyuan/core

## 0.2.0

### Minor Changes

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
- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
- 88e7d69: Add physical model-attempt and first-output telemetry, independently sampled metrics, bounded diagnostics and acceptance records, and official OpenTelemetry/OTLP adapters. Model wrappers can forward attempt observation and safe configuration identity; model-call telemetry shares detailed usage and pricing results with budgets. Bound memory retention, exporter queues, attributes, and lifecycle waits; expose missing data, export failures, and overflow counters.

  Preserve usage and pricing receipts when completed responses fail structured validation or final-event Hooks. Charge known consumption once before Context persistence and completion Hooks, keep failed Run totals visible, and calculate telemetry usage completeness consistently with budgets.
- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
- 0dc3f68: `ModelContextCompactionResult` 新增 `usage`：provider 原生压缩据此上报压缩请求自身的
  usage，OpenAI Responses 的 `/responses/compact` 已经解析该 usage 并直接返回；没有 usage
  的压缩器仍然可以只返回消息。

  `ContextSummaryRequest` 新增 `runId` 与 `step`，`SummaryTailStrategy` 把触发压缩的
  Run 身份传给摘要器，可复用的模型摘要器再把它交给 `Model.stream`。使用同一个模型的
  计账方因此可以为 Run 内的摘要调用给出可追踪的调用身份。
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
