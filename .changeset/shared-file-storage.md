---
"@sortedyuan/file-storage": minor
"@sortedyuan/session": patch
"@sortedyuan/config": patch
"@sortedyuan/media": patch
"@sortedyuan/mcp": patch
"@sortedyuan/plugin-delivery": patch
"@sortedyuan/application": patch
"@sortedyuan/coordination": patch
"@sortedyuan/maybecode": patch
---

Provide shared local file access, writer ownership and durable replacement through
the independent `@sortedyuan/file-storage` package. Configuration, media, MCP and
delivery depend directly on this storage package. Session's existing file
subpaths reexport the same functions and retain shared lock state and behavior.
