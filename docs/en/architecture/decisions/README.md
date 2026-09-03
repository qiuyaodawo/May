# Architecture decision records

**English** | [简体中文](../../../zh-CN/architecture/decisions/README.md)

This directory records decisions that constrain more than one May package or
application. An ADR explains why a boundary exists so a later refactor does
not accidentally undo it.

## Status values

- **Accepted** — current project direction.
- **Proposed** — under discussion and not yet binding.
- **Superseded** — replaced by a newer ADR, which must be linked.

## Records

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-apps-compose-packages.md) | Accepted | Applications compose reusable packages through one-way dependencies |
| [0002](0002-agent-ui-stays-in-may-tui.md) | Accepted | Agent-aware terminal components remain in `@may/tui` |
| [0003](0003-headless-application-lifecycle.md) | Accepted | Shared Session orchestration belongs in `@may/application` |
| [0004](0004-agent-definitions-and-tool-registries.md) | Accepted | Agent definitions and tool registries are reusable, instance-scoped composition objects |
| [0005](0005-observability-is-an-optional-core-port.md) | Accepted | Observability implements an optional Core-owned tracing port |
| [0006](0006-mcp-adapts-to-core-tools.md) | Accepted | MCP servers adapt to Core tools without entering the runtime kernel |

## Adding a record

Use the next four-digit number and include: context, decision, consequences and
status. Record architectural trade-offs, not routine implementation details.
If a decision changes, add a new ADR and mark the old one superseded rather
than rewriting its history.
