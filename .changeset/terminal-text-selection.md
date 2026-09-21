---
"@may/tui": minor
"@may/keybindings": minor
---

Add reusable mouse text selection, clipboard adapters, semantic component
bindings, pointer routing and selection-aware editing. Preserve text positions
through wrapping, conversation updates and resizing. Add clipboardy for local
clipboard access, diff for stable selection positions during Markdown updates,
and explicit OSC 52 output for remote terminals.

Breaking: Editor Ctrl+A selects all text; use Home for the logical line start.
Consumed boundary navigation now returns true even when the position is unchanged.
Runtime disposes its root when stopped or replaced. Hosts should make dispose
idempotent and use handleKeyResult to distinguish consumption from redraw.

MaybeCode's private application uses Ctrl+G as its default leader and reserves
Ctrl+X for cutting selected input. Update existing shortcut habits or configure
MAY_TUI_LEADER; MAY_CLIPBOARD controls clipboard access. Ctrl+C copies selected
text and interrupts only when there is no active selection.

MaybeCode leader sequences wait until completion or cancellation without a time
limit. Keymap accepts chordTimeoutMs: null for this policy. Scroll anchoring uses
nonempty text ranges so repeated redraws preserve the reading position.
