# MCP tools

**English** | [简体中文](../../zh-CN/guides/mcp.md)

`@may/mcp` lets a May application consume tools from a Model Context Protocol
(MCP) server without putting protocol or process-management code in Core. The
first release supports local stdio clients and the MCP tool capability.

## Why this is a separate package

Core already knows how to describe, authorize, schedule, cancel, execute, and
trace a `Tool`. It should not know how an external tool is discovered or
transported. `@may/mcp` therefore depends on Core and adapts a remote MCP tool
to the existing `Tool` contract:

```text
MCP server process
  ^ stdio: initialize, tools/list, tools/call
  |
@may/mcp adapter -> Core Tool -> ToolRegistry
                                  |
Model tool call -> permission -> scheduler -> adapter -> MCP server
```

This direction keeps MCP optional. An Agent with only local tools has no MCP
runtime dependency, while an MCP tool automatically uses the same permission,
scheduling, event, cancellation, Session, and tracing paths as every other
Core tool.

## Package API

Open a client pool, compose its startup tool snapshot, and close the pool at
the product ownership boundary:

```ts
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";
import { openMcpClientPool } from "@may/mcp";

const mcp = await openMcpClientPool({
  servers: [{
    id: "workspace",
    command: "node",
    args: ["./mcp-server.mjs"],
    cwd: process.cwd(),
    env: { ACCESS_TOKEN: process.env.ACCESS_TOKEN! },
    required: false,
    requestTimeoutMs: 60_000,
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
try {
  // submit runs
} finally {
  await application.close();
  await mcp.close();
}
```

Opening performs the MCP initialization handshake and an aggregated
`tools/list` request for each server. Servers are required by default: a
required server failure closes already-opened servers and fails startup. A
server with `required: false` instead records a failed status and lets the
remaining servers start. `close()` is idempotent, visits every connection even
if one close fails, and owns termination of the child processes spawned by the
stdio transport.

`requestTimeoutMs` sets the per-request inactivity timeout;
`maxTotalTimeoutMs` can additionally bound total time even when progress keeps
arriving. `maxBufferSize` limits one protocol message. When omitted, the MCP
SDK defaults apply.

`pool.status()` returns a point-in-time view of every configured server,
including its connection state, discovered tool names, latest diagnostic, and
recent stderr. `pool.events` publishes connected, failed, and disconnected
lifecycle events so products do not need to parse logs.

Stdio stderr is piped instead of inherited. Its sanitized tail is retained per
server for diagnostics and bounded by `stderrMaxBytes` (16 KiB by default), so
a noisy child cannot grow memory without limit. Treat this output as sensitive:
servers may print paths, tokens, or other secrets to stderr.

## Names and collisions

A remote tool is exposed to models as:

```text
mcp__<server-id>__<remote-tool-name>
```

Server ids may contain letters, digits, `_`, and `-`. Other characters in a
remote name are converted to `_`; long names receive a deterministic hash and
are bounded to 64 characters. Startup fails on any remaining collision. This
means an MCP tool never silently replaces a local tool or a tool from another
server.

The adapter preserves the remote `inputSchema` and returns MCP `content` plus
optional `structuredContent`. Protocol and transport failures become
`MCP_TOOL_CALL_FAILED`; a valid result with `isError: true` becomes
`MCP_TOOL_ERROR`, with bounded textual detail so the model can react. Core
cancellation is forwarded to the SDK. MCP progress notifications become Core
tool progress events.

## MaybeCode configuration

MaybeCode reads stdio servers from `apps.maybecode.mcpServers`:

```json
{
  "apps": {
    "maybecode": {
      "mcpServers": {
        "workspace": {
          "transport": "stdio",
          "command": "node",
          "args": ["tools/mcp-server.mjs"],
          "cwd": ".",
          "required": false,
          "env": {
            "ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}"
          },
          "requestTimeoutMs": 60000,
          "maxTotalTimeoutMs": 300000,
          "maxBufferSize": 10485760,
          "stderrMaxBytes": 16384
        },
        "temporarily_disabled": {
          "enabled": false
        }
      }
    }
  }
}
```

`transport` is optional and currently accepts only `stdio`. A missing
`mcpServers` entry, `false`, or an empty object disables MCP. Relative `cwd`
values are resolved from the active coding workspace; omitted `cwd` also uses
that workspace. `required` defaults to `true`; use `false` only when the product
can continue without that server. Arguments are passed directly without a shell.

Environment values can reference the launching process with `${NAME}`. A
missing referenced variable fails startup instead of passing an empty secret.
Resolved environment values stay in memory and are not added to built-in
traces. Prefer references over literal secrets because the configuration file
is plaintext.

MaybeCode starts MCP before opening the workspace, adds the discovered tools to
its normal `ToolRegistry`, and closes MCP after the Agent workspace but before
flushing observability. Its default coding permission policy asks for approval
for every MCP tool. An allow-for-session decision remains scoped to the normal
MaybeCode Session permission executor.

Run `/mcp` in either MaybeCode UI to inspect configured servers, states,
discovered tools, startup errors, and retained stderr. The controller event
stream also exposes the lifecycle events for other front ends and integrations.

## Tracing and security

With a tracer, the adapter emits:

| Span | Meaning |
| --- | --- |
| `may.mcp.connect` | child process start and protocol initialization |
| `may.mcp.tools.list` | startup discovery snapshot |
| `may.mcp.tool.call` | one remote call, parented to the Core tool span |
| `may.mcp.disconnect` | client and process shutdown |

Attributes include server id, transport, exposed and remote tool names, ids,
counts, status, and duration through the tracer. Built-in instrumentation does
not capture command arguments, environment values, request input, response
content, prompts, or model messages.

An MCP server is executable code with the host user's authority, not a sandbox.
It can also supply model-visible tool descriptions. Only configure trusted
servers, review their command and package source, apply least-privilege
environment and filesystem access, and keep the permission layer enabled.

## Current scope

This phase intentionally excludes MCP resources, prompts, sampling/elicitation
handlers, HTTP transports, server authoring, automatic reconnect, and dynamic
`tools/list_changed` refresh. Tools are a startup snapshot and become available
on the next MaybeCode launch after a server changes its list.

See the [official MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and the [TypeScript client documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)
for protocol-level details.
