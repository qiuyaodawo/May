---
"@sortedyuan/providers": minor
---

Capability discovery queries the model endpoint of every built-in adapter, using the configured `baseURL` or the adapter's default service address and that adapter's authentication: OpenAI-compatible adapters request `/models`, `anthropic-messages` requests `/v1/models`, and `google-gemini` requests `/models/{model}`. It reads reasoning efforts from `models[]` entries matched by `slug`, `data[]` entries matched by `id`, or a single Gemini model resource, using `supported_reasoning_levels`, `reasoning_levels` or `effort.supported_levels`. Services that publish these fields now report known reasoning efforts without a `capabilities` declaration.

Behavior changes: connections without `baseURL` now send one discovery request to the default service address, cached for the resolver's TTL. Capability diagnostics name this discovery `model-list` instead of `cpa-codex`. Tests that must stay offline can pass `createModelCapabilityResolver({ discoveries: [] })` or point `baseURL` at a local address.
