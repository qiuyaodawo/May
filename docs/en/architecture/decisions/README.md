# Architecture decision records

**English** | [简体中文](../../../zh-CN/architecture/decisions/README.md)

These records explain dependency direction, lifecycle ownership and optional
integration boundaries across May packages and applications. For implementation
details, use the [package catalog](../../reference/packages.md) and
[runtime architecture](../runtime-session.md).

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

Use the next four-digit number. Include status, date, context, decision and
consequences. Link affected packages and guides. A changed architectural decision
requires a new record and an explicit supersession link. Keep usage instructions
in the corresponding guides and review the ADR's applicability when APIs evolve.
