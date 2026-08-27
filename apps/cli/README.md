# May CLI

The first May composition application. It loads `@may/config`, creates a
DeepSeek model, runs `@may/core`, and streams the result to the terminal.
The default config path is `~/.may/config.json`.

```bash
pnpm may run "你好"
pnpm may run --provider deepseek "解释 agent loop"
pnpm may run --model reasoner "解释 agent loop"
pnpm may run --config ./config.json "你好"
```

Selection order:

1. `--model` selects a named entry from `models`.
2. `--provider` uses `providers.<name>.model`.
3. Without either option, `defaultModel` is used when configured.
4. Otherwise, a single configured provider is selected automatically.

Reasoning deltas are written to stderr and answer text is written to stdout.
The MVP supports DeepSeek only and does not yet include tools, interactive
sessions, or persistence.
