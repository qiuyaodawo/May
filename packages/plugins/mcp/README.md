# @may/plugin-mcp

`createMcpPlugin(options)` provides `mcpService`, opens an actual MCP pool during
setup, registers its dynamic tool catalog, and owns transport cleanup. It accepts
`OpenMcpClientPoolOptions` plus `dataDirectory`, `enableInteractions`, and an
optional `open` factory. With a data directory, task journals and OAuth credential
stores are created when the configured servers require them. Session ownership,
approval, cancellation, catalog revisions, and reconnect behavior follow `@may/mcp`.

`createMcpHostPlugin(options)` provides `mcpHostService` at host scope and optionally
uses `observabilityHostService`. It keeps connections across application/Session
changes. `createSharedMcpPlugin(pool)` contributes an existing pool to an
application and leaves transport ownership with the original host. Closing the
host cancels and closes the actual transports; side effects are not replayed.

Read the [Chinese version](README.zh-CN.md).
