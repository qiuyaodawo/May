# May CLI

The first May composition application. It loads `@may/config`, creates a model
through `@may/providers`, runs `@may/core`, and streams the result to the
terminal.
The default config path is `~/.may/config.json`.

```bash
pnpm may run "你好"
pnpm may run --model reasoner "解释 agent loop"
pnpm may run --config ./config.json "你好"
```

Selection order:

1. `--model` selects a named entry from `models`.
2. Without it, `defaultModel` is used when configured.
3. Otherwise, a single configured model profile is selected automatically.

Reasoning deltas are written to stderr and answer text is written to stdout.
The built-in registry supports `deepseek-chat`, `zhipu-chat`, `kimi-chat`,
`anthropic-messages`, `openai-responses`, and
`openai-chat-completions`. The CLI does not yet include tools, interactive
sessions, or persistence.
