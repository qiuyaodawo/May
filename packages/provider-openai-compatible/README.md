# `@may/provider-openai-compatible`

Low-level helpers for building May providers on OpenAI-compatible Chat
Completions APIs.

The package provides:

- May message and tool conversion;
- SSE parsing;
- reasoning and text stream aggregation;
- streamed function-call assembly;
- usage conversion and completion validation.

It does not send HTTP requests or define provider configuration. Authentication,
request parameters, endpoint URLs, HTTP error parsing, and provider-specific
behavior remain in each provider package.
