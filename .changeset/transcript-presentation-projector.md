---
"@sortedyuan/tui": minor
"@sortedyuan/maybecode": patch
---

**Breaking:** `TranscriptStore` projects tool presentation metadata through an injectable `ToolPresentationProjector`, and coding change previews are decoded by the standard coding projector in `@sortedyuan/tui/tool-renderers`. `ToolTranscriptItem.presentation` replaces `preview` and `renamePreviews`, and `TranscriptStore.attachToolPresentation()` replaces `appendChangePreview()`.

Migration: read change and rename previews with `readCodingToolPresentation(item)`, and replace `store.appendChangePreview(runId, step, toolCallId, preview)` with `store.attachToolPresentation(runId, step, toolCallId, codingChangePresentation(preview))`. Pass `toolPresentationProjector` to `new TranscriptStore()` to display another presentation format. MaybeCode uses the new interface; its terminal output is unchanged.
