---
"@sortedyuan/maybecode": patch
"@sortedyuan/tui": minor
---

Support pressing Esc to return to the previous individual question throughout first-run setup,
including custom protocols, credentials, and advanced model settings. Keep the
wizard on one terminal screen while switching between menus and text inputs.

Add an optional onEscape callback to TerminalIO.question for ordinary and password
input, allowing applications to cancel the current question through its signal.
