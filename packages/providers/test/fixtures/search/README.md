# Search recordings

`anthropic-direct.sse` is the unchanged HTTP response captured on 2026-11-07 by
`test/search/integration/search.test.mjs` through the configured local gateway.
The requested model was `codex/gpt-6-luna`, using the `anthropic-messages`
protocol, `web_search_20260209`, and `allowedCallers: ["direct"]`.

The response contains a server search call, its sources, text citations and
token usage. It does not report `usage.server_tool_use`, a container or
`pause_turn`. It verifies the gateway's Anthropic-compatible protocol.

Additional request bodies, response bytes and parsed events from live runs
are stored in the ignored workspace `.test-output/server-search/` directory.
No credentials or request headers are recorded.

`anthropic-mixed-0.sse` and `anthropic-mixed-1.sse` are consecutive real
responses from the same configured gateway and model. The first response
contains both a completed server search and an `add` function call. The
second follows the real arithmetic result `343`. These recordings verify
original function argument strings and mixed-tool native history replay.
