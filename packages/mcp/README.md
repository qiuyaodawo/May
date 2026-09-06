# `@may/mcp`

Model Context Protocol client adapters for May agents. The client
connects to local stdio and remote Streamable HTTP servers, snapshots `tools/list`, and exposes every
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

Local stdio MCP servers execute with the host user's authority. Put their tools behind a
permission policy, pass secrets through the environment rather than source
control, and only configure servers you trust.

HTTP endpoints use `McpHttpServerOptions` (part of `McpServerOptions`):

```ts
const remote = await openMcpClientPool({
  servers: [{
    id: "remote",
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN!}` },
    protocolMode: "auto",
  }],
});
// Compose remote.tools into the application's registry; close after use.
await remote.close();
```

HTTP defaults to SDK `auto` negotiation (`server/discover`, with legacy
`initialize` fallback); stdio keeps `legacy` as its default. Both accept
`protocolMode: "auto" | "legacy"`. Auto mode on stdio can spawn a separate
short-lived discovery process. `status()` includes the selected protocol version.
HTTP requires HTTPS except for loopback (`localhost`, `127.0.0.1`, `[::1]`),
rejects credentials/fragments in the URL and protocol-header overrides, and
never follows redirects. Static headers and native OAuth are supported; see the [authentication guide](../../docs/en/guides/mcp-auth.md).
HTTP SDK error details are withheld from diagnostics/traces (status codes are
retained when available). Tool-level error content remains visible to the caller.
Legacy HTTP sessions are terminated on close, with at most five seconds for
DELETE cleanup, followed by local transport cleanup. No automatic reconnect,
stream resumption, general tool-call retry, or fallback to deprecated HTTP+SSE is enabled.
`connected` means setup and discovery succeeded, not continuous HTTP health.

Resources, prompts, sampling/elicitation handlers, dynamic catalogs,
Tasks/Apps extensions, and MCP server authoring remain outside this phase.
See the [bilingual MCP guide](../../docs/en/guides/mcp.md) and [full adaptation roadmap](../../docs/en/architecture/mcp-host-roadmap.md).
