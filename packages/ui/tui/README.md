# `@may/tui`

Terminal UI components for May agents. The low-level primitives remain usable
without a provider or product application, while the agent transcript layer
projects May runtime, permission, and session events into a retained view.

The first milestone provides:

- component, interactive-component, and render-result contracts;
- Unicode-aware text wrapping and clipping;
- vertical composition, scrolling, selection, and multiline text editing;
- safe terminal Markdown rendering;
- semantic theme tokens and ANSI style helpers;
- explicit focus management and a batched TUI runtime;
- a retained screen buffer and differential full-screen renderer;
- a Node terminal driver that emits `@may/keybindings` key strokes and treats
  bracketed paste as one safe multiline input operation;
- a readline-backed `TerminalIO` adapter for prompt-driven applications, with
  history, live suggestions, prompt-safe asynchronous output, and normalized
  one-key reads;
- a reusable `TranscriptStore` and `TranscriptView` for live and restored agent
  runs, exposed through `@may/tui/transcript`;
- an instance-scoped tool-renderer registry and standard coding-tool renderers,
  exposed through `@may/tui/tool-renderers`.

Use `NodeTerminalDriver` when an application owns a retained, raw-mode screen.
Use `createNodeTerminal` when it needs line-oriented questions and occasional
temporary full-screen views. The latter is also available through the
`@may/tui/node-terminal` subpath.

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

`TuiTheme` deliberately contains presentation tokens rather than product-domain
types. Applications own their concrete palette and may pass it into components.
Product events and labels stay outside the transcript projection: applications
use `reset`, `appendNotice`, and `appendChangePreview` to bridge that state.
