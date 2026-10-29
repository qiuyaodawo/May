# @sortedyuan/provider-openai

## 0.2.0

### Minor Changes

- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
- 2a44905: Preserve ordered image replies from OpenAI Responses and expose reusable raster
  attachment validation, storage and reading. Terminal views support Kitty/iTerm2
  graphics and saved-file information; Web UI provides session-scoped authenticated
  image access, viewing and downloads. Hosts can supply custom media readers.
  Existing text-only consumers remain compatible.
- 0dc3f68: `ModelContextCompactionResult` 新增 `usage`：provider 原生压缩据此上报压缩请求自身的
  usage，OpenAI Responses 的 `/responses/compact` 已经解析该 usage 并直接返回；没有 usage
  的压缩器仍然可以只返回消息。

  `ContextSummaryRequest` 新增 `runId` 与 `step`，`SummaryTailStrategy` 把触发压缩的
  Run 身份传给摘要器，可复用的模型摘要器再把它交给 `Model.stream`。使用同一个模型的
  计账方因此可以为 Run 内的摘要调用给出可追踪的调用身份。
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

- 78bde1d: 提供 `@sortedyuan/provider-openai-compatible/http`，共用 SSE 读取与 `Retry-After` 处理。
  SSE 使用 `eventsource-parser`，支持 UTF-8 分段、LF/CRLF/CR、流结束及中止后的连接释放。
  各个 provider 保留其协议完成条件与错误类型。
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/core@0.2.0
  - @sortedyuan/provider-openai-compatible@0.2.0
