---
"@sortedyuan/plugin-services": minor
"@sortedyuan/application": minor
"@sortedyuan/plugin-goals": minor
"@sortedyuan/plugin-history-memory": patch
"@sortedyuan/plugin-delegation": patch
---

Expose structural contribution registries and separate Application execution,
history and state service interfaces. Application service views preserve identity
through plugin replacement and reject access before creation or after closure.

**Breaking:** `ApplicationAccess.get()` and `GoalsPluginOptions.createAgent` now
expose `ApplicationFacade`. Type plugin integrations against the required service
interfaces. Application closing, plugin updates and skill activation belong to
the host. `services.toolSources.snapshot()` returns `Iterable<Tool>`; consumers
that need catalog methods can construct a `ToolRegistry` from that iterable.
