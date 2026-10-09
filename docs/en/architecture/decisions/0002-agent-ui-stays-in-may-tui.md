# ADR 0002: Agent-aware terminal UI stays in `@may/tui`

**English** | [简体中文](../../../zh-CN/architecture/decisions/0002-agent-ui-stays-in-may-tui.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Terminal Agents need terminal primitives, retained transcript state, event
projection and tool presentation. These components share terminal dependencies
and can expose distinct module entry points within one UI package.

## Decision

Keep both levels in the existing `@may/tui` package and expose explicit
subpaths:

- `@may/tui` for terminal primitives;
- `@may/tui/transcript` for Agent event projection and retained transcript;
- `@may/tui/tool-renderers` for instance-scoped tool presentation;
- `@may/tui/slash-commands` and `@may/tui/list-selection` for reusable input
  state.

Applications inject product labels, themes, commands, layouts and additional
event notices. A non-terminal UI consumes the headless controller directly and
does not depend on `@may/tui`.

## Consequences

- Terminal consumers discover these modules through one package.
- Low-level and Agent-aware terminal APIs remain visibly separated by module
  boundaries inside one package.
- The standard coding renderer gives `@may/tui` an optional coding-domain
  dependency; callers can replace its instance-scoped registry.
- Product UI behavior must not be moved into the generic transcript merely to
  reduce application code.

See [custom UI](../../guides/custom-ui.md) for controller and renderer integration.
