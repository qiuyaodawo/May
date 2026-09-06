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
than shadowing a tool. Use `toolSource: () => mcp.tools` for per-Run discovery snapshots.

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

Resource content/prompt expansion, sampling/elicitation handlers,
Tasks/Apps extensions, and MCP server authoring remain outside this phase.
See the [bilingual MCP guide](../../docs/en/guides/mcp.md) and [full adaptation roadmap](../../docs/en/architecture/mcp-host-roadmap.md).

## Dynamic catalogs and endpoint recovery

Use `toolSource: () => mcp.tools` on the Agent definition alongside static
`tools`; passing `mcp.tools` into a constructor instead intentionally pins that
collection. Configured MaybeCode uses the dynamic source automatically, including
after model/session changes. New catalogs affect the next Run/continue, never
an in-progress Run. Old snapshots reject with `MCP_STALE_TOOL` if a definition
changed/disappeared or the catalog became untrustworthy. The wire request is not
sent. A reconnect closes the old connection, so its snapshots cannot execute.

- `mcp.catalog()` returns deeply frozen per-server metadata: revision,
  capabilities, tools, resources, resource templates and prompts. Only advertised
  capabilities are queried; resources-only endpoints are valid. Metadata is
  untrusted server data, not permission to load URIs or execute prompts.
- `await mcp.refresh(serverId?, signal?)` explicitly refetches all advertised lists
  and publishes only a complete candidate. Each list has a 64-page cap, repeated
  cursors/duplicate identities fail closed, and retained candidate data is capped
  at 4,096 descriptors/8 MiB across lists. The refresh deadline is 60 seconds or
  `maxTotalTimeoutMs`. These are catalog limits, not an HTTP-body memory sandbox.
- Advertised list-change notifications invalidate tools immediately and schedule
  one coalesced refresh. Modern endpoints use `subscriptions/listen`, legacy
  endpoints use notification handlers. Concurrent invalidations allow at most
  three discovery attempts; failure preserves the prior metadata as stale and
  removes its tools from new Runs. No content is automatically read or attached.
- `await mcp.reconnect(serverId, signal?)` replaces only that configured endpoint,
  including optional endpoints that failed startup. In-flight tool calls make
  reconnect fail rather than interrupt/replay uncertain side effects. Old Run
  snapshots must be abandoned; the new connection gets new permission identity.
- `/mcp refresh [server-id]` and `/mcp reconnect <server-id>` expose these actions
  in both terminal UIs. `/mcp` shows revision/staleness and notification coverage
  (`active`, `partial`, `unavailable`, `legacy`, `not-advertised`). Lost modern
  subscription streams are visible failures, not silent healthy subscriptions;
  refresh/reconnect is explicit. `mcp.server.catalog-updated` signals publication.

Tool grant identity includes the complete remote definition (including output
schema/annotations), endpoint/account configuration and a connection generation,
without exposing configuration secrets. Unchanged refreshes preserve grants;
reconnect/recovery creates a new identity. After an explicit OAuth login, run
`/mcp reconnect <server-id>` before starting another Run. Each connection owns
its cache; catalogs are retained in pool memory and explicit refresh never trusts
a server's prior TTL. Closing cancels queued/active discovery and subscriptions.
