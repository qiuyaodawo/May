# `@may/tui`

May-owned terminal UI primitives. This package is intentionally independent of
May's agent core, providers, sessions, and MaybeCode.

The first milestone provides:

- component, interactive-component, and render-result contracts;
- Unicode-aware text wrapping and clipping;
- vertical composition, scrolling, selection, and multiline text editing;
- safe terminal Markdown rendering;
- semantic theme tokens and ANSI style helpers;
- explicit focus management and a batched TUI runtime;
- a retained screen buffer and differential full-screen renderer;
- a Node terminal driver that emits `@may/keybindings` key strokes and treats
  bracketed paste as one safe multiline input operation.

`Editor` supports grapheme-aware editing, optional in-process `EditorHistory`,
history navigation at the first/last logical line, `Ctrl+W` or modified
Backspace for backward word deletion, and modified Left/Right for word
movement. Applications decide whether to provide and persist history.

Run the local smoke demo with:

```sh
pnpm --filter @may/tui demo
```

Use `Tab` to move between the editor and selection list, resize the terminal to
exercise reflow, and press `Ctrl+C` to exit.

`@may/tui` is the implementation used by May's bundled terminal applications,
not the custom-UI boundary. Alternative UIs should consume the application's
headless controller and events directly.

`TuiTheme` deliberately contains presentation tokens rather than agent-domain
types. Applications own their concrete palette and may pass it into components;
tool-specific presentation belongs to the application rather than this package.
