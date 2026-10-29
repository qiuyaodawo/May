# @sortedyuan/provider-deepseek

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

- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
- 0dc3f68: Chat Completions 兼容流检测服务端顶层 `error`，HTTP 200 内的错误不再被忽略。
  `@sortedyuan/provider-openai-compatible` 导出的 `streamOpenAICompatibleResponse` 在遇到带顶层
  `error` 的 chunk 时立即通过 `protocolError` 失败，可见的错误消息保留服务端的 `message`、
  `type` 和 `code`（字符串或数字）；`error` 为空或形状非法时给出明确的诊断消息。该失败不
  会被流末尾的 `[DONE]` 或 `finish_reason` 判定覆盖，也不会产生成功的 `response.completed`。
  `OpenAICompatibleChunk` 新增可选的 `error` 字段，`OpenAICompatibleStreamError` 描述其内容。
  共享该 stream 的 deepseek、kimi、zhipu adapter 一并获得此行为，错误类别和自动重试判定保持
  原状。
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
