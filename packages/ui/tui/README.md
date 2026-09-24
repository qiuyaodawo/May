# `@may/tui`

The line-oriented `TerminalIO.updatePrompt(prompt)` method updates an active
question without replacing its draft or cursor position. `createNodeTerminal`
implements it for hosts that display changing status in their prompt.

`TranscriptStore` displays delivered steering messages from live `input.received`
events and saved `input.steering.queued` / `input.steering.delivered` records.
Both paths retain delivery order and stable row identities. Queued or cancelled
input does not appear as delivered conversation content; idle follow-up Runs use
their ordinary `input.submitted` history record.

`TerminalImages` prepares saved attachments for Kitty/iTerm2/Sixel rendering or text
display. Graphics travel separately through `RenderResult.images`; the renderer
clears placements when the viewport changes. See
[Image replies](../../../docs/en/guides/images.md) /
[图片回复](../../../docs/zh-CN/guides/images.md).

`TerminalImageSupport` queries Sixel support and character-cell pixel dimensions.
`NodeTerminalDriver.imageSupport` starts queries with the driver and refreshes
them on resize. With `createNodeTerminal`, call `imageSupport.query()` when
starting an image-enabled interface and await `imageSupport.ready()` before
printing its initial images. Terminal reports are consumed independently of
keyboard input. Pass `{ cellSize: () => terminal.imageSupport.cellSize }` as the
third `TerminalImages` argument. Custom hosts can supply their own cell metrics.
Sixel rendering requires these metrics; pending or unsupported terminals show
the saved attachment information. `TerminalImages.revision` includes changes
to prepared images and cell metrics so transcript caches can refresh.

Run `pnpm --filter @may/tui test` for component and codec tests. Run
`pnpm --filter @may/tui test:sixel` for real xterm browser-terminal tests; this
requires the Playwright Chromium installation. These tests inspect decoded
pixels and terminal state without screenshots.

On Windows, run `powershell -NoProfile -STA -File scripts/test-terminal-clipboard.ps1`
from the repository root after `pnpm build`. It saves all current clipboard
formats, runs the system clipboard, Editor and real xterm/MaybeCode interaction
tests serially, and restores the saved formats. Other platforms can explicitly
enable text-only clipboard tests with `MAY_TEST_SYSTEM_CLIPBOARD=1` after saving
their clipboard contents. Ordinary tests do not modify the system clipboard.

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
`onPointer` emits zero-based down/move/up coordinates and modifiers. Button-drag
reporting is enabled only in the alternate screen. `TuiRuntime` routes pointer
events to `handlePointer`; Column, Stack, Panel, Dialog and ScrollView translate
coordinates and retain the target through a drag. A focused `ScrollView` scrolls three rows per
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

Editor, ScrollView and SelectList use `@may/keybindings` semantic actions.
Editor accepts `keybindings` overrides and an injected `Clipboard` with async
`readText`/`writeText`. It supports mouse selection, Shift navigation, Ctrl+A,
Ctrl+C/X/V and replacement of selected text. Home/End target logical lines.
`selectedText`, `hasSelection`, `clearSelection`, and `selectAll` expose selection
state. Provide `onInvalidate` for asynchronous clipboard and edge scrolling;
`onError` reports clipboard failures. Without it failures propagate. A cut only
deletes text after a successful write with unchanged editor state. Dispose editors
and scrolling components when removing them to release drag timers.

`handleKey` returns whether a key was consumed, including navigation at a boundary.
Optional `handleKeyResult` distinguishes `consumed` from `redraw`. Runtime invokes
the richer method when supplied. `TuiRuntime.stop()` permanently releases its
root component, renderer and terminal; a failed start also releases resources.
Calling `start()` or `setRoot()` after stopping throws. Create a new runtime and
root component for another session. `setRoot()` releases the previous root;
passing the current root leaves it active. `RenderResult.textRows` carries text positions
through layout; Text and Markdown accept `sourceId` to associate wrapping with a
stable source. TranscriptView uses these positions for cross-message selection
and preserves selections through streaming updates and resizing.
Tab characters display as two columns and retain the original tab in copied text.

Custom tool renderers can implement `renderDocument(item, options)` alongside
`render()`. It returns `TextDocumentLine[]`: each line supplies `value` and an
optional `copy: { start, end }` range using UTF-16 positions in the ANSI-stripped
line. Omit `copy` for decorative lines. `ToolRendererRegistry.renderDocument`
uses this metadata; legacy string renderers keep their literal text selectable.
`TerminalImages.component(source, sourceId?)` and
`TerminalImages.render(source, size, sourceId?)` can associate captions and saved
paths with selectable text. Image pixels remain separate from text selection.

`createTerminalClipboard` supports `MAY_CLIPBOARD=auto|system|osc52|disabled`.
Local auto uses clipboardy; SSH auto reports that explicit OSC 52 configuration
is required. OSC 52 writes require terminal permission and cannot confirm receipt;
its read operation reports unsupported access. Terminal paste supplies text through
the existing bracketed paste event. User workflows are documented in
[English](../../../docs/en/getting-started.md#browse-maybecode-conversations) and
[中文](../../../docs/zh-CN/getting-started.md#查看-maybecode-对话).

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
