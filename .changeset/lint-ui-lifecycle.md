---
"@sortedyuan/ui-client": minor
"@sortedyuan/tui": minor
"@sortedyuan/web-ui": minor
---

Track browser synchronization, Web UI reads and actions, and terminal completion work through shutdown. Surface background errors through the owning connection or interface, and explicitly handle all transcript event variants.

Breaking change: `UiClient.disconnect()` and the cleanup function returned by `mountWebUI()` now return `Promise<void>`. Transcript reader, inspector, and workspace UI `dispose()` methods also return promises. `TerminalIO.close()` permits `Promise<void>`, and the Node terminal adapter waits for completion providers when closing. Await these cleanup methods before releasing their owners; synchronous custom `TerminalIO.close()` implementations remain supported.

Navigation `dispose()` is also asynchronous, and custom navigation cleanup callbacks may return `Promise<void>`; the shell waits for them during cleanup.
