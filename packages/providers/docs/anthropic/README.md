# `@sortedyuan/providers/anthropic`

Anthropic Messages API adapter for May.

## Web search

Set constructor `webSearch` or provider/model `options.webSearch` to `{}` to
enable server search; omission and `false` disable it. Fields are `version`
(default `web_search_20250305`, also `web_search_20260209` and `web_search_20260318`),
`maxUses`, `allowedDomains`, `blockedDomains`, `userLocation`, `allowedCallers`,
and `responseInclusion`. Domain lists are mutually exclusive. `responseInclusion`
requires `web_search_20260318`. Newer versions can use server code execution;
set `allowedCallers: ["direct"]` for direct search. Configuration authorizes
server execution. A client function named `web_search` conflicts with it.

Responses expose `serverToolCalls` and text `citations`, retain native blocks
and container state, and translate `pause_turn` to
`continuation: "server-tool-pause"`. May automatically continues within Run
limits; `maxServerToolContinuations` defaults to 8. Changing model, endpoint,
adapter, or search configuration during unfinished interaction raises
`ServerToolStateMismatchError`. Search usage appears as `web-search` requests.
See [configuration](../../../../docs/en/reference/configuration.md#server-search).

`promptCaching` defaults to disabled. Enable automatic caching with
`{ ttl: "5m", cacheInstructions: true }` or choose `ttl: "1h"`.
Instruction caching marks the last system block and tool with the same TTL as the
automatic breakpoint. Five-minute writes cost 1.25x base input price, one-hour
writes cost 2x, and reads normally cost 0.1x. Minimum lengths vary by model
(Sonnet 4: 1,024 tokens; Opus 4.6: 4,096 tokens). Compatible endpoints may reject
`cache_control`; disable it with `promptCaching: false`. See the bilingual
[configuration reference](../../../../docs/en/reference/configuration.md).

```ts
import { InMemoryContext, May } from "@sortedyuan/may/core";
import { AnthropicModel } from "@sortedyuan/providers/anthropic";

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
