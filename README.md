# May

May is a composable agent framework organized as a monorepo. Its packages can
be used independently or combined into complete agents and applications.

## Workspace

```text
packages/
  core/       Agent loop, contracts, events, and in-memory Context
  context/    Context factories, compaction, and model-backed summarization
  session/    Serialized runs, durable history, and session catalogs
  permissions/  Headless tool policies and approval requests
  config/     Optional application configuration loading and validation
  providers/  `@may/providers` selection, registry, and built-in composition
    openai-compatible/  Shared Chat Completions protocol helpers
    deepseek/   DeepSeek streaming model adapter
    zhipu/      Zhipu GLM streaming model adapter
    kimi/       Kimi streaming model adapter
    anthropic/  Anthropic Messages API streaming model adapter
    openai/     OpenAI Responses API adapter and native compaction
  tools/
    coding-tools/  Read, shell, edit, write, and safe change previews
  ui/
    keybindings/  Context-aware semantic keyboard mappings
    tui/          Terminal adapters, renderer, and reusable UI primitives
apps/
  cli/        Minimal command-line interface
  maybecode/ Terminal coding-agent application
examples/
  basic/      Minimal Model → Tool → Model example
  deepseek/   Live DeepSeek tool-call example
```

Future Provider, Tool, Context, and Agent packages will be added alongside
`@may/core` without introducing provider-specific dependencies into Core.

See `docs/architecture/runtime-session.md` for the boundaries between agent
definitions, sessions, runs, and steps.

See `docs/configuration.md` for the configuration reference and built-in
provider option matrix. The editor schema lives at
`packages/config/may-config.schema.json`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm test:coverage
pnpm may --help
pnpm maybecode --help
pnpm example
```

The live DeepSeek example additionally requires `DEEPSEEK_API_KEY`:

```bash
pnpm example:deepseek
```
