---
"@sortedyuan/may": minor
"@sortedyuan/media": patch
"@sortedyuan/mcp": patch
"@sortedyuan/gateway": patch
"@sortedyuan/coordination": patch
"@sortedyuan/maybecode": patch
---

Provide shared local file access, writer ownership and durable replacement through
the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
delivery reuse this storage module. Session's file
subpaths reexport the same functions and retain shared lock state and behavior.
