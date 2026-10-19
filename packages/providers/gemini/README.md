# `@sortedyuan/provider-gemini`

Native Google Gemini `streamGenerateContent` adapter for May. The built-in
adapter ID is `google-gemini`. This package is independently consumable and is
also re-exported by `@sortedyuan/providers`.

```ts
import { GeminiModel } from "@sortedyuan/provider-gemini";

const model = new GeminiModel({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
});
for await (const event of model.stream({
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
}, { signal: AbortSignal.timeout(60_000) })) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
}
```

Run with Node.js 22 or newer and `GEMINI_API_KEY` set. The default `baseURL` is
`https://generativelanguage.googleapis.com/v1beta`. Custom endpoints must include
their API version, such as `http://localhost:7861/antigravity/v1`. The adapter
appends `/models/{model}:streamGenerateContent?alt=sse` and authenticates with
`x-goog-api-key`. A model name may include the `models/` prefix.

Options are `maxOutputTokens` (positive integer), `reasoningEffort` (serialized
as `thinkingConfig.thinkingLevel`), `thinkingBudget` (integer from `-1` upward),
`includeThoughts` (boolean), and injectable `fetch`. Effort and budget are
mutually exclusive. Omitting thinking options leaves them to the server/model.
Supported levels and budget ranges depend on the selected model.

System instructions, text, JSON content, tool declarations and results are
converted to Gemini requests. Media inputs support base64 with an explicit MIME
type and URL sources through `fileData`; the server/model determines supported
URI schemes and formats. File-ID and resource sources fail before HTTP.
Tool results currently accept text and JSON content. Inline generated images,
audio and files become May content parts.

Completed messages store ordered native response parts and tool-call ID mapping
in versioned `modelState`. Pass that state back with assistant messages to retain
`thoughtSignature`, including after Session serialization. Preserve assistant
tool calls with their matching results. Unknown response parts, unmatched tool
results, blocked responses, non-`STOP` finishes and incomplete streams fail.
The request signal cancels HTTP and SSE reading.

`responseFormat` supports JSON and JSON Schema through `responseMimeType` and
`responseJsonSchema`. May validates the final response. Compatible gateways must
honor these fields; invalid JSON/schema output raises
`ModelResponseValidationError` with the observed usage receipt.

Usage retains `promptTokenCount` as input including cache hits and adds
`candidatesTokenCount` and `thoughtsTokenCount` for output. Cache reads are marked
as included in input; reasoning is included in output. `totalTokenCount` is
preserved. Unreported detail fields remain absent. Tool-use prompt counts have
an explicit unknown inclusion relation and make usage partial.

Run focused checks with `pnpm --filter @sortedyuan/provider-gemini test`. Real service
checks use `pnpm --filter @sortedyuan/provider-gemini test:integration`; configure a
`google-gemini` profile in `~/.may/config.json` and optionally select it through
`MAY_GEMINI_MODEL_PROFILE`. They cover signed tool continuation, structured
output and cancellation without a simulated service.
