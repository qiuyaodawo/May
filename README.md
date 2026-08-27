# May

May is a composable agent framework organized as a monorepo. Its packages can
be used independently or combined into complete agents and applications.

## Workspace

```text
packages/
  core/       Agent loop, contracts, events, and in-memory Context
  config/     Optional application configuration loading and validation
  providers/
    openai-compatible/  Shared Chat Completions protocol helpers
    deepseek/   DeepSeek streaming model adapter
    zhipu/      Zhipu GLM streaming model adapter
    kimi/       Kimi streaming model adapter
    anthropic/  Anthropic Messages API streaming model adapter
  tools/
    coding-tools/  Read, bash, edit, and write tools
apps/
  cli/        Minimal command-line interface
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
pnpm may --help
pnpm example
```

The live DeepSeek example additionally requires `DEEPSEEK_API_KEY`:

```bash
pnpm example:deepseek
```
