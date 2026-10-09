# May

May is a composable Agent framework. Use its packages to connect models and tools,
save conversations, handle permissions, and build terminal, browser, or Gateway
applications. The public APIs and persistence formats are in developer preview.

## Documentation

- [English documentation](docs/en/README.md) / [简体中文文档](docs/zh-CN/README.md).
- [Run your first Agent application](docs/en/getting-started.md): a real model,
  one tool, and a resumable Session.
- [Build an Agent](docs/en/guides/building-an-agent.md): choose the components
  and policies for your application.
- [Package reference](docs/en/reference/packages.md): find the public entry points.
- [Configuration reference](docs/en/reference/configuration.md): provider
  connections, model profiles, and application settings.
- [Compatibility](docs/en/reference/compatibility.md): API, persistence, and
  runtime requirements.

## Applications

- [MaybeCode](docs/en/guides/maybecode.md) provides a coding Agent with terminal
  and Web interfaces, approvals, tools, instructions, and Session navigation.
- [MaybeClaw](docs/en/guides/maybeclaw.md) connects May and external Agents to
  Web, CLI, Telegram, and Feishu through a Gateway. It manages sessions, access,
  approvals, collaboration, cancellation, and durable delivery using SQLite.
- [May CLI](apps/cli/README.md) demonstrates direct Core use.

## Workspace

Reusable code lives in `packages/`; products in `apps/` select and configure those
packages. Examples live in `examples/`. Dependencies flow from applications into
reusable packages.

- `@may/core` runs the model/tool loop; `@may/context` manages the model-visible view.
- `@may/session` saves history; `@may/application` owns application and workspace lifecycle.
- `@may/permissions` evaluates tool policy and handles approval requests.
- `@may/providers` selects configured models; individual provider packages implement protocols.
- `@may/plugin` and `@may/plugin-services` compose scoped services, state, and Hooks;
  reusable plugins live in `packages/plugins/`.
- `@may/coordination` runs durable teams and task graphs. `@may/scheduler` triggers
  host tasks. `@may/eval` evaluates repeated tasks and compares configurations.
- MCP, Skills, media, tracing, coding tools, and UI packages extend these components.

Read [the runtime architecture](docs/en/architecture/runtime-session.md) for
lifecycle and resource ownership, and the [package catalog](docs/en/reference/packages.md)
for component-specific guides and constraints.

## Development

Use Node.js 22.16.0 or newer and pnpm 12.4.2, as declared in `package.json`.
Node.js 24 is recommended in `.node-version`. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm docs:check
pnpm test
```

See [repository development](docs/en/guides/repository-development.md) for focused
tests, package installation checks, CI environments, and live-provider checks.
See [MaybeCode usage](docs/en/guides/maybecode.md) to start the local coding application.
