---
"@sortedyuan/core": minor
"@sortedyuan/config": minor
"@sortedyuan/providers": minor
"@sortedyuan/provider-openai": minor
"@sortedyuan/provider-openai-compatible": minor
"@sortedyuan/provider-anthropic": patch
"@sortedyuan/provider-deepseek": patch
"@sortedyuan/provider-kimi": patch
"@sortedyuan/provider-zhipu": patch
---

Add field-level model, adapter and connection capabilities with refreshable bounded discovery, redacted diagnostics and independent verification records. Built-in model composition validates request capabilities, reasoning parameters and declared resource/schema constraints before execution, with an optional policy requiring known support. Optional Model preflight validates requests before physical attempt records and budget reservations begin.

Add provider-neutral JSON and JSON Schema response formats, configuration defaults and Ajv validation of final responses. OpenAI Responses and Chat Completions serialize native structured-output formats. Adapters without response-format transport reject unsupported format requests before sending.

Final response validation errors carry Usage/cost receipts and physical completion through ModelResponseValidationError. Runtime, budgets and retry attempt telemetry retain accounting for failed structured responses; completed validation failures are never retried and error messages exclude response content.
