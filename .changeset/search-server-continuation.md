---
"@sortedyuan/may": minor
---

Add server-tool call states, URL citations, original tool arguments, and server-tool update events. Automatically continue paused server interactions with bounded continuation counts and preserve pending state during context management. Include explicit Tool.usage(output) and ToolUsageError receipts in Run totals and budgets, and expose server-search capability fields. Tools report successful usage through the optional usage method and failed usage through ToolUsageError.
