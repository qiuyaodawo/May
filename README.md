# May

May is a composable agent framework organized as a monorepo. Its packages can
be used independently or combined into complete agents and applications.

## Workspace

```text
packages/
  core/       Agent loop, contracts, events, and in-memory Context
examples/
  basic/      Minimal Model → Tool → Model example
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
