# `@may/tui`

`TerminalImages` prepares saved attachments for Kitty/iTerm2 rendering or text
display. Graphics travel separately through `RenderResult.images`; the renderer
clears placements when the viewport changes. See
[Image replies](../../../docs/en/guides/images.md) /
[图片回复](../../../docs/zh-CN/guides/images.md).

Terminal UI components for May agents. The low-level primitives remain usable
without a provider or product application, while the agent transcript layer
projects May runtime, permission, and session events into a retained view.
Both layers intentionally remain in `@may/tui`; May does not introduce a
separate `@may/agent-tui` package for the Agent-aware components.

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

`NodeTerminalDriver` enables SGR mouse reporting while the alternate screen is
active and disables it on exit. Mouse input is decoded with `tty-events`;
vertical wheel events emit `wheelup` and `wheeldown` key strokes without text.
Other mouse events are consumed. A focused `ScrollView` scrolls three rows per
wheel event. Product views may route wheel events to their transcript while
keeping keyboard focus in the editor.

`TranscriptStore.latestReply` exposes the current turn's final assistant item
after `run.completed`, including restored session events. New input, a new run,
and session reset clear it. Empty final text has no reply target.
Call `TranscriptView.revealLatestReply()` and then
`ScrollView.scrollToAnchor(() => view.latestReplyAnchor)` to position the first
Markdown body row at the viewport top. The anchor is resolved after rendering
and follows layout changes until manual navigation. Short replies leave space
below them. Revealing a reply retains its entire body and subsequent displayed
items, so this explicit reading operation may exceed the normal tail row limit.

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
