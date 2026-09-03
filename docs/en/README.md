# May documentation

**English** | [简体中文](../zh-CN/README.md)

May is a composable Agent framework. These documents explain how to assemble
its packages into an application, how runtime state is divided, and which
interfaces are intended for extension.

## Start here

1. [Getting started](getting-started.md) — define a reusable Agent, compose its
   tools, and open a durable `AgentApplication`.
2. [Building an Agent](guides/building-an-agent.md) — choose models, tools,
   instructions, Context, permissions, Session storage and UI.
3. [Package reference](reference/packages.md) — select the smallest May layer
   for an application.

## Concepts

- [Agent and Application](concepts/agent-application.md)
- [Session, Run and Step](concepts/session-run-step.md)
- [Context and durable history](concepts/context-and-history.md)
- [Events](concepts/events.md)
- [Runtime and Session architecture](architecture/runtime-session.md)

## Extension guides

- [Custom model](guides/custom-model.md)
- [Custom tool](guides/custom-tool.md)
- [Custom Context](guides/custom-context.md)
- [Custom Session storage](guides/custom-storage.md)
- [Custom UI](guides/custom-ui.md)
- [Permission policy](guides/permission-policy.md)
- [Observability and tracing](guides/observability.md)

## Reference

- [Packages](reference/packages.md)
- [Configuration](reference/configuration.md)
- [Compatibility and stability](reference/compatibility.md)
- [Architecture decisions](architecture/decisions/README.md)

## Reference applications

- [MaybeCode](../../apps/maybecode/README.md) is the full terminal coding-Agent
  composition.
- [May CLI](../../apps/cli/README.md) is a smaller direct-runtime example.

Package-level READMEs remain the closest reference for individual exports.
Only package entry points declared in `exports` are public; see
[Compatibility and stability](reference/compatibility.md) for the current
developer-preview guarantees.

## Languages and maintenance

English documents live under `docs/en/`. Complete Simplified Chinese mirrors
live under `docs/zh-CN/` with the same relative paths. Update
both files in a pair whenever behavior changes, and run `pnpm docs:check`
before committing documentation changes.
