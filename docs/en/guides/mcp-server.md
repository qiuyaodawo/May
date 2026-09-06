# Independent MCP server exports

**English** | [简体中文](../../zh-CN/guides/mcp-server.md)

## Separate, opt-in surface

Import `createMayMcpServer` from `@may/mcp/server`. It does not start a listener,
discover coding tools, open a Session, call a model or read history. Supply explicit
tool/resource/prompt exports, authentication, per-method/per-target authorization
and the normal `ToolExecutor`. Missing security services are configuration errors.

The official server SDK 2.0.0 provides serving and protocol validation. Default
serving is modern `2026-07-28`. `legacy: "stateless"` explicitly allows stateless
legacy HTTP and legacy stdio negotiation, not the retired two-endpoint SSE transport.
These exports are bounded immediate tools, fixed resources and prompts—not automatic
Tasks/Apps export, resource templates, completion, subscriptions, server-initiated
Host requests, progress relay or operation replay. Client capabilities and server
authoring capabilities are separate.

## Minimal stdio example

```ts
import { createMayMcpServer } from "@may/mcp/server";
import { PermissionToolExecutor } from "@may/permissions";

const workspaceId = "explicit-workspace";
// Allow only this harmless example tool. Real apps must use their normal policy/UI.
const executor = new PermissionToolExecutor({ policy: () => "allow" });
const server = createMayMcpServer({
  endpoint: "http://127.0.0.1/mcp", // This does not start a listener.
  workspaceId,
  authenticate: async () => undefined, // No HTTP access in this example.
  authorize: async ({ principal }) => principal.id === "local-launcher",
  executor,
  tools: [{
    tool: {
      name: "echo", description: "Echo a provided message",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(input) { return input; },
    },
    result: output => ({ content: [{ type: "text", text: JSON.stringify(output) }] }),
  }],
});
server.serveStdio({ id: "local-launcher", workspaceId });
// On shutdown: await server.close(); await executor.close();
```

The stdio launcher must establish the local principal (e.g. from an authenticated
OS/session boundary), never stdin parameters. Default messages are limited to
1 MiB. A custom transport is trusted integration code and must enforce equivalent
framing/size constraints. Reserve stdout for protocol traffic. `serveStdio` returns
a close handle; the server does not own the injected executor.

## HTTP authentication and isolation

Route your framework's Web `Request` to `server.fetch(request)` and return its Web
`Response`. The external URL must exactly match `endpoint`; HTTPS is required
except for literal loopback HTTP. Preserve and validate Host/Origin at a reverse
proxy; never reconstruct URLs from untrusted forwarded headers. Only POST is served.
Browser origins are denied unless explicitly in `allowedOrigins`; there is no
wildcard origin, automatic CORS or preflight handler. Your application owns any
listener; importing the package cannot expose a public service.

`authenticate(request, signal)` must validate token/signature, audience/resource,
expiry and revocation, returning `{ id, workspaceId, expiresAt? }` (Unix milliseconds).
Authentication precedes body parsing and discovery. Missing credentials receive
401; a different workspace receives 403. For provisioned opaque bearer tokens,
`createMayMcpBearerAuthenticator(grants)` supplies `.authenticate` and `.revoke(token)`;
it retains token digests and uses constant-time comparison. Tokens must be generated
independent secrets of at least 32 characters, not passwords or principal ids.
This is not an OAuth authorization server or protected-resource metadata endpoint.
OAuth deployments supply their own verifier/issuer/metadata routing; client OAuth
support does not imply server-side token verification.

Each instance is fixed to **one workspace**, never a path supplied in RPC params.
Authenticated principals are copied/frozen. Calls get host-generated Run/tool-call
ids and a principal/workspace-bound export session label, not client Session ids.
This is not an existing May Session and grants no history access. Exported tools
must still enforce their actual filesystem sandbox; routing labels are not an OS
sandbox. Resource/prompt callbacks receive the trusted principal/workspace and signal.

`authorize({ principal, workspaceId, signal, method, target? })` applies to every
request, discovery item and operation. Lists hide unauthorized entries; direct
hidden/unknown target access fails before callbacks. HTTP credentials are checked
again after waits, immediately before tool side effects and before returning data.
Revoking a token while permission approval is pending prevents execution.

## Export contracts and limits

- `tools: [{ tool, result }]`: explicit Core Tool allowlist; validate input JSON
  Schema, run `parse`, use the supplied executor, then guarded `tool.execute`.
  `result` is a **mandatory public projection**: raw output/events/provider secrets
  are never automatically exported. Return valid MCP tool content. Failures use a
  generic `isError`, not exception payloads. Reusable grants must be principal-scoped;
  tool permission identity also binds workspace/principal/definition.
- `resources: [{ definition, read }]`: fixed exact URI allowlist; `read(context)`
  returns only that URI. No implicit `file://` mapping or path traversal.
- `prompts: [{ definition, get }]`: explicit templates; `get(args, context)` receives
  declared string arguments, checks required arguments and rejects unknown ones.
  No implicit conversation export.

Definitions are snapshots: construct a new server to change them. Each kind allows
256 unique exports; metadata/content is bounded to 8 MiB and 128 content/message
items. HTTP bodies/default stdio messages are limited to 1 MiB; HTTP batches and
subscription streams are rejected. HTTP supports 64 concurrent requests, each
stdio instance the same handler bound, and at most 16 stdio handles can be opened.
Default request deadline is 60 seconds, configurable up to five minutes. Callbacks
must honor cancellation; stopping local waiting cannot undo a side effect from a
callback ignoring its signal. No unknown outcome is retried. HTTP responses use
`Cache-Control: no-store`; resource results and SDK discovery defaults use zero
TTL/private scope. Closing aborts requests/SDK handles, not the application listener
or injected executor.

## Evidence

`packages/mcp/test/server.test.mjs` uses a real HTTP endpoint through May's MCP
client: authentication/workspace rejection, principal-filtered discovery, normal
permission denial, revocation during approval, public projection, input validation,
resources/prompts, oversized input and shutdown. A real stdio child process checks
modern/explicit legacy negotiation and launcher identity. This is focused integration
evidence, not universal MCP certification.
