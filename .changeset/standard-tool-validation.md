---
"@sortedyuan/may": minor
"@sortedyuan/mcp": minor
"@sortedyuan/gateway": minor
---

Add defineTool with Standard Schema validation and draft-07 input schema conversion. Validation failures expose field paths through ToolInputValidationError. Tool parsing supports asynchronous validation and preserves null and undefined results across MCP execution.

Migration: callers invoking tool.parse() directly must await its result. Execution adapters await parsing, check cancellation, and freeze the parsed input before execution.
