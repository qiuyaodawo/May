# Isolated MCP Apps

**English** | [简体中文](../../zh-CN/guides/mcp-apps.md)

## Opt-in graphical Host

May provides a backend App session, browser mounting adapter and separate-origin
sandbox document for the [MCP Apps extension](https://apps.extensions.modelcontextprotocol.io/).
The UI protocol is pinned to `2026-01-26`, independently of the MCP connection.
This is a deliberately restricted Host, not support for every optional Apps API.

Pass `apps: { executor, approve }` to `openMcpClientPool` only in a graphical Host.
`executor` must be your normal permission executor. `approve` must explicitly
review opening the resource and each subsequent resource read, and honor its
signal. No default allow policy is supplied. This advertises
`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`. After an explicit
user action, call `pool.openApp(serverId, remoteToolName, { owner, signal })`.
The owner comes from your authenticated Host workspace/Session, never App params.

The returned `McpAppSession` has `resource`, `receive(message)`,
`notification(kind, params)` and `close()`. Keep it on the backend. Connect only
one authenticated renderer channel to it; do not expose the pool, executor,
credentials, general RPC forwarding or Session history. Pass a lifetime signal
that aborts on Session switch, logout and UI disposal. The default view lifetime
is ten minutes (maximum one hour), with at most 16 open/opening views per connection,
four concurrent requests and 256 unique request ids per view. Duplicate ids close
the view rather than replaying actions. Reconnect, invalidation, changed catalogs
or authorization and pool shutdown revoke use of old views.

## Browser integration

Serve `mcpAppSandboxResponse(hostOrigin)` on a **dedicated different origin**,
including all returned HTTP headers and body unchanged. That origin must have no
cookies, credentials, other application routes or untrusted content hosting.
Production hosts should use separate HTTPS origins; local testing permits literal
loopback HTTP. The sandbox URL is trusted host configuration, not `_meta.ui.domain`.

```ts
// Browser bundle: this subpath has no Node imports.
import { mountMcpApp } from "@may/mcp/apps-browser";
const view = mountMcpApp(container, trustedSandboxUrl, {
  resource: { html: backendAppResource.html },
  receive: message => authenticatedChannel.request(message),
  close: () => authenticatedChannel.close(),
  signal: viewLifetimeSignal,
});
```

The outer proxy uses a separate origin and an iframe sandbox; the inner view has
an opaque origin and script-only sandbox permissions. Both hops verify message
source/origin. The proxy HTTP CSP and inner policy block network fetches, external
scripts/assets, nested frames, forms, plugins and base changes; inline scripts and
styles plus data images/media remain available. Server-requested CSP domains,
permissions and persistent origins do **not** loosen policy. Camera, microphone,
geolocation and clipboard are denied. Apps requiring external dependencies may
not work: use self-contained HTML or retain text fallback. Browsers still control
self-navigation; the proxy removes a view on subsequent navigation. Do not treat
CSP as a general-purpose protection against disclosing any secret given to an App.
Only supply data the user has approved sharing with that server.

`ui/initialize` / `ui/notifications/initialized` negotiate the view. Supported
requests are `ping`, same-server `tools/call` through the normal permission path,
and approved `resources/read` for the linked UI or catalog-listed resources.
Tool visibility is enforced: app-only tools never enter the model's registry,
model-only tools cannot be called by Apps, and names never route to another server.
Malformed visibility fails closed. The linked `ui://` resource may be omitted from
the public resource catalog; its exact URI/MIME and bounded HTML are validated.

Only after initialization, explicitly send host-selected input/result/cancellation
via `view.send(await app.notification("tool-result", result))` (with an authenticated
backend equivalent). No automatic result interception or rendering is installed;
the custom Host chooses the originating call's data and when to open its view.
There is no `ui/message` or `ui/update-model-context`, automatic navigation,
external link opening, App-provided host tools, display-mode changes, or log relay.
Unsupported requests receive an explicit error, never mutate Context, and are not
silently forwarded. HTML is limited to 2 MiB, incoming RPC to 256 KiB and results
to the existing 8 MiB limit. Close both the mount and backend session on teardown.

## Terminal fallback and evidence

MaybeCode terminals do not enable/advertise Apps. `/mcp apps` explicitly reports
that HTML cannot run; ordinary model-visible tool text remains usable, app-only
tools stay hidden, and no UI resource is fetched automatically. Configuration
cannot silently install a browser Host. Generic resource attachment remains data,
not executable HTML.

`packages/mcp/test/apps.test.mjs` checks permission denial before remote execution,
visibility, owner routing, resource consent, stale views and fallback. Its optional
real Chromium test verifies double-iframe origin isolation, CSP-blocked fetch,
source spoof rejection and teardown. Set `MAY_PLAYWRIGHT_MODULE` to an installed
Playwright module and optionally `MAY_CHROMIUM_PATH` to run it; no browser download
or new test dependency is required for normal tests.

Host callback waiting is abortable even when a custom consent/executor callback
ignores its signal; late completion is never replayed or delivered to a closed view.
Callbacks must still honor cancellation to stop their own work.
