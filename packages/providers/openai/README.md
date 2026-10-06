# `@may/provider-openai`

Generated image output is represented as ordered `ContentPart` image entries.
`openAIResponseContent(message)` reads presentation content from native output
state when required. See [Image replies](../../../docs/en/guides/images.md) /
[图片回复](../../../docs/zh-CN/guides/images.md).

OpenAI Responses API adapter for May. It supports streaming text and reasoning
summaries, function tools, stateless opaque continuation state, server context
management configuration, and explicit `/responses/compact` compaction.
User input supports images and files backed by URL, base64 data, or an OpenAI
file id. Unsupported audio and generic resource parts fail explicitly instead
of being stringified.

```ts
import { OpenAIResponsesModel } from "@may/provider-openai";

const model = new OpenAIResponsesModel({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.4",
  reasoningEffort: "high",
  reasoningSummary: "auto",
});
```

The adapter stores native output and encrypted compaction items in May's
opaque `modelState`. Core and other providers never inspect that state.

`ModelRequest.responseFormat` configures JSON output with `{ type: "json" }` or
JSON Schema output with `{ type: "jsonSchema", name, schema, strict? }`. The
adapter sends the corresponding `text.format`, validates schema configuration
before the request, and validates final response content through Ajv. Draft-07
and 2020-12 are supported for local validation. Provider schema restrictions
must also be satisfied. Tool-call responses allow intermediate empty bodies.
Invalid final output throws `ModelResponseValidationError` with the completed
response's Usage receipt. Runtime and budget accounting retain the actual
usage while the response remains failed, and retry wrappers do not retry it.
