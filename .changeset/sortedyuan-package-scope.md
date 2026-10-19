---
"@sortedyuan/application": minor
"@sortedyuan/coding-tools": minor
"@sortedyuan/config": minor
"@sortedyuan/context": minor
"@sortedyuan/coordination": minor
"@sortedyuan/core": minor
"@sortedyuan/eval": minor
"@sortedyuan/goal": minor
"@sortedyuan/keybindings": minor
"@sortedyuan/maybecode": minor
"@sortedyuan/mcp": minor
"@sortedyuan/media": minor
"@sortedyuan/observability": minor
"@sortedyuan/permissions": minor
"@sortedyuan/plugin": minor
"@sortedyuan/plugin-agent-adapters": minor
"@sortedyuan/plugin-coordination": minor
"@sortedyuan/plugin-delegation": minor
"@sortedyuan/plugin-delivery": minor
"@sortedyuan/plugin-goals": minor
"@sortedyuan/plugin-history-memory": minor
"@sortedyuan/plugin-mcp": minor
"@sortedyuan/plugin-models": minor
"@sortedyuan/plugin-observability": minor
"@sortedyuan/plugin-permissions": minor
"@sortedyuan/plugin-runtime": minor
"@sortedyuan/plugin-services": minor
"@sortedyuan/plugin-skills": minor
"@sortedyuan/plugin-web-api": minor
"@sortedyuan/provider-anthropic": minor
"@sortedyuan/provider-deepseek": minor
"@sortedyuan/provider-gemini": minor
"@sortedyuan/provider-kimi": minor
"@sortedyuan/provider-openai": minor
"@sortedyuan/provider-openai-compatible": minor
"@sortedyuan/provider-zhipu": minor
"@sortedyuan/providers": minor
"@sortedyuan/scheduler": minor
"@sortedyuan/session": minor
"@sortedyuan/session-tools": minor
"@sortedyuan/skills": minor
"@sortedyuan/tui": minor
"@sortedyuan/ui-client": minor
"@sortedyuan/web-ui": minor
---

Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
names, imports, pnpm filters, and configured module specifiers from `@may/` to
`@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
command and its headless API through `@sortedyuan/maybecode`.

Plugin IDs, saved Session data, configuration locations, and the Anthropic message
state format retain their existing identities. OpenTelemetry instrumentation
uses `@sortedyuan/observability`; update filters that select instrumentation by name.

The TUI package includes the PNG declarations required by its image dependency,
so consumers can type-check installed declarations with `skipLibCheck: false`.
