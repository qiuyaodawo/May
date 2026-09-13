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
