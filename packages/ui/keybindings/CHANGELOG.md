# @sortedyuan/keybindings

## 0.2.0

### Minor Changes

- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.
- 81d6852: Add reusable mouse text selection, clipboard adapters, semantic component
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
