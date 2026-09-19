# `@may/provider-openai-compatible`

An OpenAI-compatible Chat Completions model adapter and shared protocol helpers.

The package provides `OpenAIChatCompletionsModel` plus:

- May message and tool conversion;
- text/JSON and URL/base64 image input conversion;
- SSE parsing;
- reasoning and text stream aggregation;
- streamed function-call assembly;
- usage conversion and completion validation.

Provider-specific packages reuse the conversion and streaming helpers while
retaining their own request extensions and error handling.

The `@may/provider-openai-compatible/http` subpath exports `readSseData` and
`parseRetryAfterMs`, shared by the Anthropic, OpenAI Responses, and Chat
Completions adapters. SSE parsing uses `eventsource-parser` and accepts LF,
CRLF, and CR line endings, including a final event without a blank line at EOF.
The reader releases the response body when aborted or when iteration ends early.
`parseRetryAfterMs` accepts seconds (including decimals) or an HTTP date and
returns milliseconds; missing or unrecognized values return `undefined`.

Audio, file, and generic resource parts are rejected rather than silently
serialized. Accepting an image wire format does not imply that every model
behind an OpenAI-compatible endpoint has vision capability.
