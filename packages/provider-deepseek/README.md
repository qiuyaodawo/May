# `@may/provider-deepseek`

DeepSeek model adapter for May.

```ts
import { May, InMemoryContext } from "@may/core";
import { DeepSeekModel } from "@may/provider-deepseek";

const may = new May({
  model: new DeepSeekModel({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: "deepseek-v4-flash",
  }),
  context: new InMemoryContext(),
});
```

The adapter uses DeepSeek's streaming Chat Completions endpoint and preserves
`reasoning_content` across tool-call turns.

See the [DeepSeek API documentation](https://api-docs.deepseek.com/zh-cn/).
