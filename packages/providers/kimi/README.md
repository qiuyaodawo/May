# `@may/provider-kimi`

Kimi model adapter for May.

```ts
import { InMemoryContext, May } from "@may/core";
import { KimiModel } from "@may/provider-kimi";

const may = new May({
  model: new KimiModel({
    apiKey: process.env.MOONSHOT_API_KEY!,
    model: "kimi-k3",
    reasoningEffort: "high",
    maxTokens: 4096,
  }),
  context: new InMemoryContext(),
});
```

`maxTokens` maps to Kimi's current `max_completion_tokens` field.

Thinking configuration differs by model:

- `kimi-k3` always thinks; use `reasoningEffort` and omit `thinking`.
- `kimi-k2.7-code` always thinks with preserved thinking; omit `thinking`.
- `kimi-k2.6` accepts `thinking.type` and optional `thinking.keep`.

Example for preserved thinking with `kimi-k2.6`:

```ts
new KimiModel({
  apiKey,
  model: "kimi-k2.6",
  thinking: { type: "enabled", keep: "all" },
});
```

The regular test suite is fully offline. A real API integration test is
available but remains opt-in and unverified until credentials are configured:

```sh
pnpm test:integration:kimi
```

It finds a model profile using the `kimi-chat` adapter in
`~/.may/config.json`. Do not commit that file or print its contents in logs.

See the [Kimi thinking model documentation](https://platform.kimi.ai/docs/guide/use-thinking-models).
