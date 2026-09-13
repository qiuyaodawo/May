# @may/ui-client

UI-neutral developer-preview contracts and a browser-safe client. This package
does not depend on TUI rendering or a product. The root entry exports JSON DTOs,
`UiHost`, `UiClient`, `UiError`, and command validation helpers.

- `@may/ui-client/application`: `ApplicationUiHost`, adapting one
  `AgentWorkspaceController` with one execution session and independent client history views.
- `@may/ui-client/projection`: bounded runtime/history presentation without
  provider continuation state or terminal components.
- `@may/ui-client/server`: authenticated loopback server and mountable UI router.
  A custom server **must authenticate and validate origins before calling the router**.

`UiClient` synchronizes authoritative snapshots using an authenticated fetch/SSE
invalidation stream. Reconnects resnapshot; they do not replay commands.
Host epochs reject uncertain commands after restart. Receipts deduplicate up to
4,096 unique commands per host lifetime; reaching the limit fails closed until a
controlled restart. Receipts are not a durable command log or exactly-once network guarantee.

See [English](../../../docs/en/guides/web-ui.md) or
[简体中文](../../../docs/zh-CN/guides/web-ui.md) for setup, protocol and limitations.

`selectedId` identifies the viewed resource; session hosts also expose `activeId`.
`select(id)` reads history without activating it. `session.activate` and
`session.new` require `expectedActiveId`; `UiClient` supplies it from the current
snapshot. Browsing depends on `readSessionHistory` and safe store inspection.
This preview replaces the old `session.open` UI command; upgrade host and client together.


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
