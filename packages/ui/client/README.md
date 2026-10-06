# @may/ui-client

`createTelemetryPanel(data)` creates a reusable bounded diagnostic panel using
the public `UiTelemetryData` and `UiTelemetryRecord` DTOs. It shows independent
span durations, outcome, parent identity, sampling selection and retention
coverage, with at most 40 rows. Hosts authorize and page diagnostic queries.

Optional `UiSnapshot.workspace`, `forkPoints`, `checkpoints` and `worktrees` fields
carry structured workspace versions and Session ancestry. `ApplicationUiOptions`
accepts asynchronous callbacks with these names; hosts retain Git and fork policy.
`UiReceipt.diff` returns `UiWorkspaceDiff` with file status, binary flags, statistics
and unified patches. `UiClientState.diff` exposes the current command's diff and
clears it when changing Session. The fields remain optional for non-file hosts.

`ApplicationUiOptions.badges` supplies current host status as optional
`UiSnapshot.badges`. Each `UiBadge` has a text `label` and optional `neutral` or
`warning` tone. Hosts publish changes through their event stream or `changed()`;
badges describe current host state even when browsing historical sessions.

`UiProjection` renders delivered steering messages with the same row identities
for live events and Session history. It preserves delivery order and the owning
Run; pending or cancelled input does not appear as delivered conversation content.
History search and field reads include the full saved steering text beyond the
bounded snapshot preview.

`UiBlock.content` preserves ordered text and image attachments. `UiHost.media`
and `UiClient.readMedia` provide authenticated, resource-scoped image access.
See [Image replies](../../../docs/en/guides/images.md) /
[图片回复](../../../docs/zh-CN/guides/images.md).

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
Custom product servers can import `BrowserLogin` from `@may/ui-client/server`
and mount `issue()`, `redeem(ticket)`, and `clear()` alongside authenticated
product routes. Tickets retain the same single-use and expiry rules.

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

Persistent requests display the host-supplied range description and scope ID,
with an `allow-persistent` choice. `ApplicationUiHost` accepts
`permissionActor: () => string` to obtain the trusted operator identity. Hosts
without this option omit the persistent choice. Web command arguments cannot
provide `createdBy`; the host passes it to `resolveApproval()`.
Historical `UiApprovalRecord.scope` can be `persistent`, with
`scopeDescription` retaining the displayed range. Optional
`permissionRules: { list, revoke, create? }` callbacks advertise
`permission.rules.list` and `permission.rules.revoke`. List output includes
descriptions, scope, creator and expiry with explicit revoke actions. The host
must restrict callbacks to the current operator's permitted scopes; revoke
commands also check that the requested ID is in that list.
An optional `create(sourceId, decision)` callback enables
`permission.rules.create`. The operator chooses an allow or deny rule based on
an existing visible range; the callback derives the trusted rule identity and
operator itself. Commands carry only that source rule ID and the decision.
The confirmation displays the complete range and deny precedence.
`UiPanel.actions` contains optional host-declared controls. `ApplicationUiHost`
adds a permissions panel with a rule-list action while preserving product
panels. The Web shell applies the same confirmation, pending-state and command
availability handling used for command-output actions.


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
