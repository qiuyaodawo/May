# `@may/mcp`

Model Context Protocol client adapters for May agents. The first implementation
connects to local stdio servers, snapshots `tools/list`, and exposes every
remote tool as a normal Core `Tool`.

```ts
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";
import { openMcpClientPool } from "@may/mcp";

const mcp = await openMcpClientPool({
  servers: [{
    id: "workspace",
    command: "node",
    args: ["./server.mjs"],
    cwd: process.cwd(),
    required: false,
  }],
  tracer,
});

const agent = defineAgent({
  model,
  tools: ToolRegistry.compose(localTools, mcp.tools),
  permissionPolicy,
  tracer,
});

const application = await agent.open({ store });
// ...use the application...
await application.close();
await mcp.close();
```

Remote names are exposed as `mcp__<server-id>__<tool-name>`. Names are made
provider-safe and bounded to 64 characters; collisions fail startup rather
than shadowing a tool. Discovery is a startup snapshot in this release.

The adapter forwards Core cancellation signals and MCP progress notifications,
maps MCP tool-level errors to `MCP_TOOL_ERROR`, and closes every spawned child
process when the pool closes. Optional tracing emits `may.mcp.connect`,
`may.mcp.tools.list`, `may.mcp.tool.call`, and `may.mcp.disconnect` without
recording commands, arguments, environment values, tool input, or tool output.

Each server is required by default. Set `required: false` to keep the pool
usable when that server fails; its diagnostic remains available through
`pool.status()`. `pool.events` publishes connected, failed, and disconnected
lifecycle events. Stderr is piped instead of written directly to the terminal,
sanitized, and retained as a bounded 16 KiB tail by default.

MCP servers execute with the host user's authority. Put their tools behind a
permission policy, pass secrets through the environment rather than source
control, and only configure servers you trust. Resources, prompts, HTTP
transport, dynamic tool-list refresh, and an MCP server implementation are not
part of this first client release.
