---
"@sortedyuan/may": minor
"@sortedyuan/gateway": minor
"@sortedyuan/providers": minor
"@sortedyuan/coordination": minor
"@sortedyuan/mcp": minor
"@sortedyuan/observability": minor
"@sortedyuan/tui": minor
"@sortedyuan/coding-tools": minor
"@sortedyuan/eval": minor
"@sortedyuan/media": minor
"@sortedyuan/scheduler": minor
"@sortedyuan/ui-client": minor
"@sortedyuan/web-ui": minor
"@sortedyuan/maybecode": minor
---

Consolidate the framework into `@sortedyuan/may`, including Core, Application,
Session, Context, permissions, configuration, storage, Skills, plugin hosting,
services, goals and history memory. Provider implementations use subpaths of
`@sortedyuan/providers`. Gateway adapters, RPC, delivery and HTTP services use
`@sortedyuan/gateway`. Capability plugins use their owning package's public
subpaths; TUI includes keybindings. Update all consumers to use the same framework
module identities and runtime dependency chain.

**Breaking:** Replace component dependencies and imports using
`docs/en/guides/package-subpaths.md` or `docs/zh-CN/guides/package-subpaths.md`.
Install `@sortedyuan/may` for framework imports such as
`@sortedyuan/may/session/file-store`; install `@sortedyuan/providers` for protocol
imports such as `@sortedyuan/providers/deepseek`. Rebuild applications and third-party
plugins together. Preserve plugin IDs, service IDs, configuration data and saved
Session state. MaybeCode carries the consolidated dependencies in its published
installation; its command names remain unchanged.
