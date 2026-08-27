# `@may/provider-zhipu`

Zhipu GLM model adapter for May.

```ts
import { InMemoryContext, May } from "@may/core";
import { ZhipuModel } from "@may/provider-zhipu";

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

It expects `providers.zhipu.apiKey`, `baseURL`, and `model` in
`~/.may/config.json`. Do not commit that file or print its contents in logs.

See the [Zhipu API documentation](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode).
