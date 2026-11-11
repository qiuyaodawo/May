# `@sortedyuan/providers/deepseek`

DeepSeek model adapter for May.

## Host web search

`deepseek-chat` rejects `webSearch`, including `false`, with
`ProviderConfigurationError`. To search, create a `web_search` tool with
`createDeepSeekSearchBackend` and `createWebSearchTool` from
`@sortedyuan/coding-tools`, then register it with the runtime. The backend
calls `/v1/tools/search` using the configured API key and base URL; successful
requests contribute `web-search` usage. MaybeCode configures this through
`apps.maybecode.webSearch.hostTool: { backend: "deepseek", provider: "deepseek" }`.
Host search passes through tool permissions. See
[configuration](../../../../docs/en/reference/configuration.md#maybecode-search-and-language-servers).

```ts
import { May, InMemoryContext } from "@sortedyuan/may/core";
import { DeepSeekModel } from "@sortedyuan/providers/deepseek";

const may = new May({
  model: new DeepSeekModel({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: "deepseek-v4-flash",
    maxTokens: 4096,
  }),
  context: new InMemoryContext(),
});
```

The adapter uses DeepSeek's streaming Chat Completions endpoint and preserves
`reasoning_content` across tool-call turns. It is built on
`OpenAICompatibleChatModel` and reports failures with the shared
[OpenAI-compatible errors](../openai-compatible/README.md) whose `provider` is
`"DeepSeek"`.

## Live integration test

The regular test suite is fully offline. To run the opt-in test against the
real API, fill in `~/.may/config.json` and run:

```sh
pnpm test:integration:deepseek
```

Expected configuration:

```json
{
  "providers": {
    "deepseek": {
      "adapter": "deepseek-chat",
      "apiKey": "",
      "baseURL": "https://api.deepseek.com"
    }
  },
  "models": {
    "deepseek": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    }
  },
  "defaultModel": "deepseek"
}
```

Do not commit this file or print its contents in logs.

See the [DeepSeek API documentation](https://api-docs.deepseek.com/zh-cn/).
