# `@sortedyuan/providers/zhipu`

Zhipu GLM model adapter for May. It is built on `OpenAICompatibleChatModel` and
reports failures with the shared [OpenAI-compatible errors](../openai-compatible/README.md)
whose `provider` is `"Zhipu"`.

## Web search

Set constructor `webSearch` or provider/model `options.webSearch` to
`{ searchEngine: "search_std" }` to authorize server search. Omission and
`false` disable it. Engines are `search_std`, `search_pro`, `search_pro_sogou`,
and `search_pro_quark`; optional fields are `count`, `domainFilter`,
`recencyFilter`, `contentSize`, and `searchPrompt`. Responses expose sources in
`serverToolCalls` with generated `may:web_search:<responseId>` IDs. Unreported
search counts mark usage partial with `web-search-usage-unreported`.
For host execution with tool approvals, use coding-tools
`createZhipuSearchBackend` with `createWebSearchTool` and leave server search
disabled. See [configuration](../../../../docs/en/reference/configuration.md#server-search).

```ts
import { InMemoryContext, May } from "@sortedyuan/may/core";
import { ZhipuModel } from "@sortedyuan/providers/zhipu";

const may = new May({
  model: new ZhipuModel({
    apiKey: process.env.ZHIPU_API_KEY!,
    model: "glm-5.2",
    maxTokens: 4096,
  }),
  context: new InMemoryContext(),
});
```

The adapter uses Zhipu's streaming Chat Completions endpoint. Thinking is
enabled by default with `clear_thinking: false`, which preserves
`reasoning_content` for agent and tool-call continuations. Requests containing
tools also enable `tool_stream`.

The regular test suite is fully offline. A real API integration test is
available but remains opt-in and unverified until credentials are configured:

```sh
pnpm test:integration:zhipu
```

It finds a model profile using the `zhipu-chat` adapter in
`~/.may/config.json`. Do not commit that file or print its contents in logs.

See the [Zhipu API documentation](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode).
