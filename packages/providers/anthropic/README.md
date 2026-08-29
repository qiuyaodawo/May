# `@may/provider-anthropic`

Anthropic Messages API adapter for May.

```ts
import { InMemoryContext, May } from "@may/core";
import { AnthropicModel } from "@may/provider-anthropic";

const model = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "your-claude-model",
  maxTokens: 8192,
  thinking: { type: "adaptive", display: "summarized" },
  reasoningEffort: "high",
});

const run = new May({
  model,
  context: new InMemoryContext(),
}).run({ input: "Analyze this problem." });
```

The adapter uses `https://api.anthropic.com` and API version `2023-06-01` by
default. It supports streaming text and thinking, client tool calls, usage,
structured HTTP and stream errors, and cancellation.

User and tool-result content supports images and documents backed by URL,
base64 data, or an Anthropic file id. Audio and generic resource parts are
rejected explicitly.

Anthropic requires thinking and redacted-thinking blocks to be returned
unchanged during continuation. The adapter stores the complete native assistant
content in `AssistantMessage.modelState` under
`@may/provider-anthropic/message-v1`. May treats that data as opaque while the
adapter reuses it on later tool and conversation turns.

For models with adaptive thinking:

```ts
thinking: { type: "adaptive", display: "summarized" }
```

For models that support manual extended thinking:

```ts
maxTokens: 8192,
thinking: { type: "enabled", budgetTokens: 4096 }
```

Manual `budgetTokens` must be at least 1024 and less than `maxTokens` in this
MVP. Interleaved-thinking beta headers are not yet exposed.
