# `@sortedyuan/gateway`

**English** | [简体中文](README.zh-CN.md)

Agent adapters, durable message delivery and HTTP services for May hosts.
Requires Node.js 22.16.0 or later.

| Entry | Purpose |
| --- | --- |
| `@sortedyuan/gateway` | Adapter, delivery and HTTP exports |
| `@sortedyuan/gateway/adapters` | Agent adapter interfaces, registry, loading and May integration |
| `@sortedyuan/gateway/rpc` | JSON-RPC adapters over stdio or sockets |
| `@sortedyuan/gateway/delivery` | Channel interfaces, journal storage and message delivery |
| `@sortedyuan/gateway/web-api` | HTTP listener lifecycle through a host plugin |
| `@sortedyuan/gateway/examples/rpc-file-agent` | Executable file Agent for RPC integration |

`createAgentAdaptersPlugin()` provides a host registry. The registry creates
adapters when requested, shares an active creation and closes acquired adapters
when the host closes. `createMayAgentAdapter()` receives a Session store and an
Agent definition factory from the host. RPC adapters validate capabilities and
execution identity, and expose unknown outcomes for interrupted side effects.

`createDeliveryPlugin()` receives host ingress and provides channel registration
and delivery services. The host supplies access rules, routing, ordering and
storage ownership. `ChannelStore` persists the channel journal; delivery records
retain receipts and outcomes requiring inspection.

`createWebApiPlugin()` receives a handler service and owns its listener, active
requests and connections. The host supplies authentication, routes and static
content. Closing the plugin cancels request signals and waits for resource release.

Detailed references: [adapters](docs/adapters/README.md),
[delivery](docs/delivery/README.md) and [HTTP services](docs/web-api/README.md).
Run `pnpm --filter @sortedyuan/gateway test` for file, process and HTTP checks.
The [plugin package check](../../docs/en/guides/npm-release.md) also exercises
the installed package in an external consumer.
