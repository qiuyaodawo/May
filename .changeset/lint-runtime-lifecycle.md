---
"@sortedyuan/may": patch
"@sortedyuan/mcp": patch
"@sortedyuan/eval": patch
"@sortedyuan/coordination": patch
---

Keep file-operation cleanup within the caller's operation result. Wait for evaluation process cancellation, MCP subscription and transport cleanup, and delegation request background work before their owners finish closing. Propagate cleanup and delegation cancellation failures to callers.
