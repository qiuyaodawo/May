# Record and inspect model requests

**English** | [简体中文](../../zh-CN/guides/model-request-recording.md)

## Enable recording

Set `requestRecording: "required"` on `Session.create()`, `Session.resume()`,
`Session.fork()`, `AgentApplication.open()`, or `defineAgent()`. The default is
`"required"`. Set `providerBodyRecording: true` to also save the provider body;
this independent option defaults to false and must be supplied again on resume or fork. Configure a model,
runtime and Session store before enabling recording. FileSessionStore flushes
each request definition/reference batch before the provider sends its request.

```ts
const session = await Session.create({
  runtime,
  store,
  requestRecording: "required",
});
const run = await session.submit({ input: "What is 17 + 25?" });
await run.result;
const requests = await session.listModelRequests({ limit: 50 });
const attempts = await session.getModelRequest(requests[0]!.modelCallId);
```

MaybeCode accepts `apps.maybecode.requestRecording` in its configuration.
MaybeClaw Gateway accepts `apps.maybeclaw.agents[].requestRecording` for a `may`
adapter. Both accept `"off"` and `"required"`. The standalone MaybeClaw service
also accepts `MaybeClawOptions.requestRecording`.
All these configuration locations also accept the boolean `providerBodyRecording`.

## Saved contents

A version-1 `ModelRequestRecord` contains the final Core request after Hooks,
including messages, system instructions, tool descriptions and schemas, metadata,
and response format. With `providerBodyRecording: true`, it also contains the adapter-generated request body,
adapter identity, endpoint origin/path and public protocol options. Explicit
parameters and adapter defaults appear as sent; omitted server defaults stay
omitted. The endpoint excludes URL credentials, query and fragment.

Authorization, cookies and API keys used by built-in transports stay outside the
record. Request content and tool schemas are saved in the Session's existing
storage, including inline media and provider model state. Protect and delete that
storage according to the application's data policy. Remote media remain external
dependencies. Recognized HTTP resource URL fields appear in
`externalResourcePaths`; URL credentials, queries and fragments are removed from
saved resource references and identified in `omittedPaths`. Execution uses the
original prepared body. These annotations explain limits on exact reconstruction.

## Events and ordering

`model.request.defined` stores content-addressed values using canonical JSON and
SHA-256. `model.request.prepared` references ordered messages, tool definitions
and provider body fields. Definitions are written before their references;
repeated values reuse their existing definitions within the Session.

For each attempt, preparation is saved before `model.attempt.started`, followed
by network execution and `model.attempt.completed` or `model.attempt.failed`.
Completion records include duration and generation usage when supplied. Failure
records include cancellation, error class and available HTTP status. Raw provider
error messages are excluded from these request events.

An individual request record may contain at most 64 MiB of serialized UTF-8 JSON.
Recording failures stop execution and require reopening the Session. Retry
policies and automatic compaction stop on request checkpoint failures.

## Retries and compaction

Retries share `modelCallId` and receive increasing attempt numbers. Every
physical attempt saves its logical request and, when enabled, its effective body. The built-in adapters
support DeepSeek, Kimi, Zhipu, Anthropic Messages, Gemini, OpenAI Chat Completions
and OpenAI Responses. The retry and capability-validation wrappers preserve
recording support.

AgentApplication wraps its configured model with the same recorder for summary
and native compression calls. Summary and native compression records use
`purpose: "compaction"` and separate call identities. Direct Core users can apply
`withModelRequestRecording(model, sink)` when creating their own summarizers or
calling `model.contextCompactor` independently.

## Query and display

Session and AgentApplication expose `listModelRequests({ afterSeq?, limit? })`
and `getModelRequest(modelCallId)`. The default page limit is 50 and the maximum
is 1000. Continue using the last returned `seq` as `afterSeq`.
`getModelRequest()` returns all saved attempts for one logical call.

The WebUI record detail panel includes a Model request tab for assistant and
Run records backed by Session history. It uses the existing bounded field reader.
MaybeClaw Gateway conversation views direct operators to the underlying Agent
Session query because their conversation records have a separate representation.

## Recovery and branches

Query status is `prepared` before a saved attempt start, `unknown` after a start
without an outcome, and `completed`, `failed` or `cancelled` after a saved outcome.
The network may not have started after a saved start record. Reading requests
never sends them or executes tools.

Reopening validates definition digests and references. Branches retain the
selected event prefix and its definitions. Historic configuration describes the
saved call; subsequent execution uses the application's current configuration.
Old histories return no request records. Builds that do not recognize the new
event types reject those histories explicitly.

## Custom adapters and runtimes

Adapters declare `supportsRequestRecording: true` and use
`executeRecordedRequest(record, options.recordRequest, options.signal, execute)`
after all request transformations. The helper serializes the body once, awaits
the recorder, then passes that exact serialization to `execute`. Native
non-streaming calls use `executeRecordedOperation`. Providers construct an
explicit public record and keep authentication separate.

Custom runtimes declare the same capability and forward Run/continue
`recordRequest` sinks to model calls with `runId`, `step` and `modelCallId`.
Wrappers preserve capability declarations and recorder options. Required mode
rejects runtimes and models that do not declare support before calling them.

## Verification

After `pnpm build`, run the request-history checks with
`node --test packages/providers/test/request-recording.test.mjs`.
Run the actual-provider scenario with
`node --test packages/providers/test/request-recording/integration/session.test.mjs`.
It uses the configured default profile, or `MAY_RECORDING_MODEL`, and verifies
saved requests, reopen, branching, deduplication and subsequent execution.
