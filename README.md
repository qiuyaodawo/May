# May

May is a composable agent framework organized as a monorepo. Its packages can
be used independently or combined into complete agents and applications.

## Workspace

```text
packages/
  core/       Agent loop, ToolRegistry, contracts, events, and in-memory Context
  mcp/        Stdio / Streamable HTTP MCP clients and remote-tool adapters
  observability/  Optional fail-open tracing processors and exporters
  application/  Agent definitions plus single-session/workspace lifecycle
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
    coding-tools/  Read, shell, edit, write, instructions, and change previews
    session-tools/ Read-only access to bounded durable session history
  ui/
    keybindings/  Context-aware semantic keyboard mappings
    tui/          Terminal primitives plus reusable Agent transcript components
apps/
  cli/        Minimal command-line interface
  maybecode/ Terminal coding-agent application
examples/
  basic/      Minimal Model → Tool → Model example
  deepseek/   Live DeepSeek tool-call example
```

`packages` contains the contracts and reusable components used to construct an
Agent; `apps` contains executable products that select and configure those
components. Dependencies point from applications into packages, never from a
reusable package into `apps/maybecode` or another product. Packages may depend
on lower-level packages: for example, `@may/application` composes Core,
Context, Session, permissions, and the optional session-history tool, while
`@may/tui` projects Core, permission, and Session events for terminal display.

MaybeCode is the main reference product. It delegates generic run, approval,
compaction-persistence, and multi-session lifecycle to `@may/application` and
uses the Agent transcript from `@may/tui`. It retains coding-product policy:
the prompt and instruction sources, coding tools and permission defaults,
model profiles and reasoning effort, compaction strategy order, commands,
theme, layout, and terminal interaction flow.

The packages are currently versioned `0.1.0`; their public APIs and the
file-backed persistence formats should be treated as developer-preview APIs,
not as a promise of production or compatibility stability.

Start with the [English documentation](docs/en/README.md) or the
[简体中文文档](docs/zh-CN/README.md), then follow
[Getting started](docs/en/getting-started.md). The
[runtime architecture](docs/en/architecture/runtime-session.md) describes the
boundaries between Agent definitions, applications, sessions, runs, and steps.
The [configuration reference](docs/en/reference/configuration.md) documents the
built-in provider option matrix; its editor schema lives at
`packages/config/may-config.schema.json`.

## Development

Repository development requires Node.js 22 or newer and pnpm 11.23.0.
Node.js 24 is recommended and recorded in `.node-version` for version managers
that support it. Individual packages retain their existing runtime requirements.

```bash
pnpm install
pnpm build
pnpm docs:check
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
