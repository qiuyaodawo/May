# `@may/provider-deepseek`

DeepSeek model adapter for May.

```ts
import { May, InMemoryContext } from "@may/core";
import { DeepSeekModel } from "@may/provider-deepseek";

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
`reasoning_content` across tool-call turns.

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
