# May

May is a composable agent framework organized as a monorepo. Its packages can
be used independently or combined into complete agents and applications.

## Workspace

```text
packages/
  core/       Agent loop, contracts, events, and in-memory Context
  provider-openai-compatible/  Shared Chat Completions protocol helpers
  provider-deepseek/  DeepSeek streaming model adapter
  provider-zhipu/     Zhipu GLM streaming model adapter
  provider-kimi/      Kimi streaming model adapter
  provider-anthropic/ Anthropic Messages API streaming model adapter
examples/
  basic/      Minimal Model → Tool → Model example
  deepseek/   Live DeepSeek tool-call example
```

Future Provider, Tool, Context, and Agent packages will be added alongside
`@may/core` without introducing provider-specific dependencies into Core.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm test:coverage
pnpm example
```

The live DeepSeek example additionally requires `DEEPSEEK_API_KEY`:

```bash
pnpm example:deepseek
```
