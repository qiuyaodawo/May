---
"@sortedyuan/session": minor
"@sortedyuan/mcp": patch
---

Add configurable acquisition timeouts and AbortSignal cancellation to withFileAccess, with ownership retained until an active callback settles.

Coordinate the complete MCP credential lock lifecycle across processes so Windows pending-delete handles cannot interrupt concurrent credential operations. Preserve the existing lock recovery procedure and ten-second acquisition limit.
