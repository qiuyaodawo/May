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

- `@sortedyuan/may` provides the runtime, Context, Session, Application, permissions,
  configuration, Skills and plugin services through public subpaths.
- `@sortedyuan/providers` selects configured models and exposes each protocol through a subpath.
- `@sortedyuan/gateway` provides Agent adapters, RPC, durable delivery and HTTP services.
- Feature plugins belong to the package providing their capability; MaybeClaw owns its channels.
- `@sortedyuan/coordination` runs durable teams and task graphs. `@sortedyuan/scheduler` triggers
  host tasks. `@sortedyuan/eval` evaluates repeated tasks and compares configurations.
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
