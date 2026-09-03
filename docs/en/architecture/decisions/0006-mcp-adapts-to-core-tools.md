# ADR 0006: MCP adapts to Core tools

**English** | [简体中文](../../../zh-CN/architecture/decisions/0006-mcp-adapts-to-core-tools.md)

- Status: Accepted
- Date: 2026-09-03

## Context

May needs to consume capabilities from Model Context Protocol servers. Adding
MCP behavior directly to the Agent loop would couple every Agent to a protocol
SDK, duplicate tool execution paths, and risk bypassing existing permission,
scheduling, cancellation, Session, and tracing behavior.

An MCP stdio connection also owns a child process whose lifetime is longer than
one tool call or Session. Tool names from different servers can collide, and
server-provided descriptors are untrusted model-visible input.

## Decision

Create the optional `@may/mcp` package. It depends on `@may/core` and adapts an
MCP server's tool descriptors and calls to Core's existing `Tool` contract.
Core and `@may/application` do not depend on MCP.

An application opens an instance-scoped MCP client pool, composes its
namespaced tool snapshot through `ToolRegistry`, and closes the pool at the
product ownership boundary. Therefore all calls continue through the selected
Core `ToolExecutor` and `ToolScheduler`; products retain control of permission
policy. Cancellation and trace context are explicitly propagated.

The initial implementation supports stdio initialization, aggregated
`tools/list`, and `tools/call`. It uses startup snapshots, deterministic
provider-safe names, collision failure, bounded error details, and explicit
connection/process shutdown. Resources, prompts, HTTP, server authoring, and
dynamic list refresh are deferred.

Servers are required by default, while an application may mark a server
optional so its startup failure does not disable unrelated tools. The pool
retains bounded sanitized stderr for diagnostics and exposes explicit status
snapshots and connection lifecycle events; products should observe those
contracts rather than parse process output.

## Consequences

- Agents that do not use MCP do not load its SDK or process-management code.
- MCP tools reuse existing permission, scheduling, event, cancellation, and
  Session behavior instead of creating a parallel runtime.
- Applications must own and close a pool; a Session does not own shared MCP
  processes.
- Optional-server failures are visible and isolated; required-server failures
  remain fail-fast.
- A changed remote tool list requires reconnecting/restarting in this phase.
- Server ids and remote names become part of a preview model-facing naming
  contract and collisions fail fast.
- MCP servers remain trusted executable dependencies; adapting them to a Tool
  does not sandbox them or make their descriptions trustworthy.
