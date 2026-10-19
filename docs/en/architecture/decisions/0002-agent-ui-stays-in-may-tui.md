# ADR 0002: Agent-aware terminal UI stays in `@sortedyuan/tui`

**English** | [简体中文](../../../zh-CN/architecture/decisions/0002-agent-ui-stays-in-may-tui.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Terminal Agents need terminal primitives, retained transcript state, event
projection and tool presentation. These components share terminal dependencies
and can expose distinct module entry points within one UI package.

## Decision

Keep both levels in the existing `@sortedyuan/tui` package and expose explicit
subpaths:

- `@sortedyuan/tui` for terminal primitives;
- `@sortedyuan/tui/transcript` for Agent event projection and retained transcript;
- `@sortedyuan/tui/tool-renderers` for instance-scoped tool presentation;
- `@sortedyuan/tui/slash-commands` and `@sortedyuan/tui/list-selection` for reusable input
  state.

Applications inject product labels, themes, commands, layouts and additional
event notices. A non-terminal UI consumes the headless controller directly and
does not depend on `@sortedyuan/tui`.

## Consequences

- Terminal consumers discover these modules through one package.
- Low-level and Agent-aware terminal APIs remain visibly separated by module
  boundaries inside one package.
- The standard coding renderer gives `@sortedyuan/tui` an optional coding-domain
  dependency; callers can replace its instance-scoped registry.
- Product UI behavior must not be moved into the generic transcript merely to
  reduce application code.

See [custom UI](../../guides/custom-ui.md) for controller and renderer integration.
