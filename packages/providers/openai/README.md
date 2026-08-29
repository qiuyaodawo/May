# `@may/provider-openai`

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
