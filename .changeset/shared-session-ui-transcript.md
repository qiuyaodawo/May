---
"@sortedyuan/session": minor
"@sortedyuan/tui": minor
"@sortedyuan/ui-client": patch
"@sortedyuan/maybecode": patch
---

Add shared Session transcript reading for user input, recovery findings, and delivered steering. Web history, search, full-field reads, and retained TUI history preserve these messages and execution outcomes consistently.

Breaking: TUI tool items now include denied, not-started, and unknown statuses, and assistant items include interrupted. Update exhaustive custom renderers to handle these states.

Validate ApplicationUiHost commands directly from current execution and ownership state. Presentation reads leave commands available, and host shutdown settles accepted work while rejecting later commands.
