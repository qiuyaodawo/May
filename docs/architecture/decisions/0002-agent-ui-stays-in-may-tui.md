# ADR 0002: Agent-aware terminal UI stays in `@may/tui`

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

MaybeCode originally contained retained transcript state, transcript views and
tool renderers. These components are useful to other terminal Agents. A
separate `@may/agent-tui` package was considered, but May itself is an Agent
framework and the extra package would create an artificial distinction between
terminal primitives and the Agent projections normally rendered with them.

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

- There is no additional `@may/agent-tui` package to discover or version.
- Low-level and Agent-aware terminal APIs remain visibly separated by module
  boundaries inside one package.
- The standard coding renderer gives `@may/tui` an optional coding-domain
  dependency; callers can replace its instance-scoped registry.
- Product UI behavior must not be moved into the generic transcript merely to
  reduce application code.
