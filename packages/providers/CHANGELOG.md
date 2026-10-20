# @sortedyuan/providers

## 0.2.1

### Patch Changes

- Updated dependencies [749fadc]
  - @sortedyuan/config@0.3.0
  - @sortedyuan/provider-anthropic@0.2.0
  - @sortedyuan/provider-deepseek@0.2.0
  - @sortedyuan/provider-gemini@0.2.0
  - @sortedyuan/provider-kimi@0.2.0
  - @sortedyuan/provider-zhipu@0.2.0

## 0.2.0

### Minor Changes

- ef3b26a: Add the native `google-gemini` adapter with streaming text and reasoning, media content, signed tool-call continuation, JSON/schema validation, cancellation, and Gemini usage accounting that includes reasoning in output and cache hits in input.
- 88e7d69: Add physical model-attempt and first-output telemetry, independently sampled metrics, bounded diagnostics and acceptance records, and official OpenTelemetry/OTLP adapters. Model wrappers can forward attempt observation and safe configuration identity; model-call telemetry shares detailed usage and pricing results with budgets. Bound memory retention, exporter queues, attributes, and lifecycle waits; expose missing data, export failures, and overflow counters.

  Preserve usage and pricing receipts when completed responses fail structured validation or final-event Hooks. Charge known consumption once before Context persistence and completion Hooks, keep failed Run totals visible, and calculate telemetry usage completeness consistently with budgets.
- 88e7d69: Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

  Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

  Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
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

- 2a44905: Preserve ordered image replies from OpenAI Responses and expose reusable raster
  attachment validation, storage and reading. Terminal views support Kitty/iTerm2
  graphics and saved-file information; Web UI provides session-scoped authenticated
  image access, viewing and downloads. Hosts can supply custom media readers.
  Existing text-only consumers remain compatible.
- Updated dependencies [02789c6]
- Updated dependencies [02789c6]
- Updated dependencies [0dc3f68]
- Updated dependencies [02789c6]
- Updated dependencies [8df2b63]
- Updated dependencies [ef3b26a]
- Updated dependencies [422e404]
- Updated dependencies [02789c6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [2a44905]
- Updated dependencies [02789c6]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [63f68e5]
- Updated dependencies [02789c6]
- Updated dependencies [88e7d69]
  - @sortedyuan/config@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/provider-gemini@0.2.0
  - @sortedyuan/provider-openai@0.2.0
  - @sortedyuan/provider-openai-compatible@0.2.0
  - @sortedyuan/provider-anthropic@0.2.0
  - @sortedyuan/provider-deepseek@0.2.0
  - @sortedyuan/provider-kimi@0.2.0
  - @sortedyuan/provider-zhipu@0.2.0
