---
"@sortedyuan/may": minor
"@sortedyuan/providers": minor
"@sortedyuan/ui-client": minor
"@sortedyuan/web-ui": minor
"@sortedyuan/maybecode": minor
"@sortedyuan/coordination": patch
"@sortedyuan/eval": patch
---

Add default-on durable logical model request recording. Sessions retain effective messages,
tool definitions, provider request bodies and individual attempt outcomes, with
content reuse and read-only history queries. Built-in providers, retry wrappers,
application summaries and native OpenAI compaction support awaited recording
before network execution. MaybeCode exposes requestRecording configuration and
the WebUI displays saved model requests in record details. Budget wrappers
preserve request-recording capability.

New request-history event types require a reader supporting this release.
Existing histories remain readable; logical recording defaults to required. Provider bodies
require the independent providerBodyRecording option. Request definitions and references
are saved in batches before dispatch. Breaking change: custom runtimes
and adapters must explicitly implement the recording capability before enabling
required mode, or explicitly select requestRecording: "off" when migrating.
Authentication remains separate from saved request content.
