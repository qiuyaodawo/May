# @may/ui-client

UI-neutral developer-preview contracts and a browser-safe client. This package
does not depend on TUI rendering or a product. The root entry exports JSON DTOs,
`UiHost`, `UiClient`, `UiError`, and command validation helpers.

- `@may/ui-client/application`: `ApplicationUiHost`, adapting one
  `AgentWorkspaceController` with one current session shared by all connected clients.
- `@may/ui-client/projection`: bounded runtime/history presentation without
  provider continuation state or terminal components.
- `@may/ui-client/server`: authenticated loopback server and mountable UI router.
  A custom server **must authenticate and validate origins before calling the router**.

`ApplicationUiHost` accepts `events` and `closeApplication: false` for an
independent view of a controller owned by a terminal. The owner distributes events
to each view and closes the application. `startUiServer` can opt into `browserLogin`
and return `createLoginUrl()` for a 60-second, single-use browser connection ticket.
The exchange keeps the control token out of URLs and preserves API authentication.

Product hosts can provide `controls`, `complete`, `available`, `submit`,
`concurrentCommands` and `interactionCommands` on `ApplicationUiOptions`.
Concurrent product commands do not hold the snapshot queue. Interaction commands
validate the host, active Session and product availability before dispatch, allowing
responses during an awaited command. Products validate the live request owner.
`UiClient.complete()` reads authenticated Session-scoped suggestions;
`interact()` sends an advertised response/cancellation without the ordinary busy
restriction. `UiReceipt.output` supplies page-local text and actions, while
`disconnect` ends the client connection. `startUiServer` exposes `closed` and an
optional `exit` callback invoked after an exit receipt is flushed.

`UiClient` synchronizes authoritative snapshots using an authenticated fetch/SSE
invalidation stream. Reconnects resnapshot; they do not replay commands.
Host epochs reject uncertain commands after restart. Receipts deduplicate up to
4,096 unique commands per host lifetime; reaching the limit fails closed until a
controlled restart. Receipts are not a durable command log or exactly-once network guarantee.

See [English](../../../docs/en/guides/web-ui.md) or
[简体中文](../../../docs/zh-CN/guides/web-ui.md) for setup, protocol and limitations.

`selectedId` identifies the viewed resource. For session hosts it equals `activeId`;
all connected clients follow the current workspace session. `select(id)` sends
`session.activate`. Activation, `session.new` and `session.delete` require
`expectedActiveId`, supplied by `UiClient`. Deletion targets `targetId` and rejects
the current session with HTTP 409, preserving its history and selection.
Snapshot reads always return the current session; history and field reads use
safe store inspection. Task hosts retain independent selection. Upgrade this
preview's host and client together when adopting these selection semantics.


Execution evidence uses `UiBlockStatus`, `UiDiagnostic`, `UiApprovalRecord` and
`UiPresentation`. Blocks can carry run/call IDs and bounded live progress. A
cancelled run does not prove a started tool had no effects: without a final
outcome, tools are `unknown`, while partial assistant text is `interrupted`.
Explicit recovery `not-started`/`unknown` records override inferred incompleteness.
Errors expose only bounded message/code, not stacks or provider continuation state.

`UiProjection.history()` creates read-only approval records, never interactions.
Only live `approval.requested` events produce actionable `UiInteraction` objects,
linked through block/run/call IDs and tool name. Terminal events clear requests;
`settle()` removes live authority when a host reports no live execution. Session
approval choices require a host grant key. Truncated approval inputs are deny-only,
and `ApplicationUiHost` validates the advertised choice again before resolving it.
Custom hosts own the same validation and lifecycle responsibilities. Reconnect to
the same live host retains pending requests; a journal alone cannot restore them.
These are preview DTO changes: upgrade custom hosts and clients together.


## Read-only history

Hosts can advertise `snapshot.reads` and implement optional `resources(request)`,
`history(selectedId, request)` and `field(selectedId, request)` methods. The client
exposes `readResources`, `readHistory` and `readField`. These authenticated GETs
require the current host epoch; resource-scoped reads reject stale client selections.
No commands or runtime transitions are involved. `snapshot.historyPage` provides
the initial older-history cursor. Page DTOs contain items, total and nextCursor.
`snapshot.resourcesVersion` optionally identifies changes to the complete resource
catalog's membership, pagination order and searchable text. Resource hosts update
it for entries outside the snapshot's recent-resource window as well. The shared
Web shell refreshes its loaded resource pages when this value changes and retains
the current search query and page count.

`@may/ui-client/reading` provides shared host-side pagination, safe field extraction
and chunk versioning. Pages contain at most 50 records with a soft 256K-character
budget. Search can inspect full persisted display fields beyond preview truncation;
provider continuation objects and permission execution contexts are excluded.
Fields return 32,768-character chunks with scope/content hashes: a changed version
requires restarting from offset zero. Paging scans existing storage; it is not an
indexed or constant-memory storage API. See the bilingual Web UI guides for limits.
