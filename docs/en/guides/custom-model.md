# Implement a model adapter

**English** | [简体中文](../../zh-CN/guides/custom-model.md)

A model adapter converts provider requests and responses to the `Model`
interface exported by `@may/core`. Use this guide when adding a provider
protocol. The adapter handles request conversion, streaming, cancellation,
and Provider errors; the application owns Session and product behavior.

Use a built-in adapter from `@may/providers` when the provider is already
supported. Implement `Model` when integrating a new protocol or when creating a
local protocol demonstration.

## Minimal implementation

The following local text transformer demonstrates the required stream protocol.
It performs uppercase conversion and has no external model service. Its limits
are example values. Create `uppercase-model.ts` in an ESM TypeScript application
with `@may/core`, `@may/application`, and `@may/session` as direct dependencies.
See [Getting started](../getting-started.md) for workspace setup.

```ts
import type {
  AssistantMessage,
  Model,
  ModelEvent,
  ModelLimits,
  ModelRequest,
  ModelStreamOptions,
} from "@may/core";

export class UppercaseModel implements Model {
  readonly limits: ModelLimits = {
    contextWindowTokens: 4_096,
    maxOutputTokens: 512,
  };

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    options.signal.throwIfAborted();

    const text = lastUserText(request).toUpperCase();
    if (text !== "") {
      yield { type: "text.delta", delta: text };
    }

    options.signal.throwIfAborted();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
    yield { type: "response.completed", message };
  }
}

function lastUserText(request: ModelRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    return message.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("");
  }
  return "";
}
```

Create `run.ts` beside it to exercise the stream through `AgentApplication`:

```ts
import { AgentApplication } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { UppercaseModel } from "./uppercase-model.js";

const application = await AgentApplication.open({
  model: new UppercaseModel(),
  store: new InMemorySessionStore(),
  permissionPolicy: () => "deny",
});

try {
  const run = await application.submit({ input: "Hello, May" });
  console.log((await run.result).message);
} finally {
  await application.close();
}
```

Compile both files and execute the emitted entry point:

```sh
pnpm exec tsc --ignoreConfig --target es2022 --module nodenext --moduleResolution nodenext --outDir dist uppercase-model.ts run.ts
node dist/run.js
```

The final assistant message contains one text part with `HELLO, MAY`. This
checks the local protocol and application lifecycle; provider integration
requires a real account and requests to that provider.

The permission policy is still required by `AgentApplication`, even when this
particular model never calls a tool.

## Stream protocol

For each `stream()` call, an adapter must:

1. emit zero or more `text.delta`, `reasoning.delta`, or `retrying` events;
2. emit exactly one `response.completed` event containing the complete final
   assistant message; and
3. finish the iterable after that completion event.

Ending without a completion or emitting two completions causes Core to fail
the run with `ModelProtocolError`. Streaming deltas are live presentation data;
the complete message from `response.completed` is the durable result.

`ModelStreamOptions.signal` is the run cancellation boundary. Pass it to the
provider SDK or `fetch`, and check it while decoding a long stream. Do not turn
an abort into a successful completion. Adapter/network exceptions may be
thrown normally; Core emits `run.failed` and rejects the run result.

The optional `runId`, `step`, and `modelCallId` fields are correlation values.
They are populated by May during a run, but remain optional so an adapter can
be exercised directly.

## Mapping requests and responses

`ModelRequest` contains:

- normalized `messages`, including a system message synthesized from Context
  instructions;
- provider-neutral tool definitions (`name`, `description`, `inputSchema`);
- optional application metadata.

Treat the `ModelRequest` and its `messages` and `tools` collections as readonly
adapter input. `ToolDefinition` fields are readonly as well. An adapter should
map these normalized values into a new provider-owned request object; it must
not sort, splice, annotate, or otherwise rewrite May's request, messages, or
tool definitions in place. This keeps retries, other adapters, Context, and
durable history isolated from provider-specific conversion.

A real adapter is responsible for validating what its provider supports. If a
content part cannot be represented, fail explicitly (the built-in adapters use
`UnsupportedContentError`) rather than silently dropping it. Provider tool
calls must be returned in the final assistant message as normalized
`toolCalls`; May executes them and supplies normalized tool messages on the
next step.

Provider continuation data can be attached to an assistant message as
`modelState`. Treat it as an opaque, namespaced, versioned value: Session
persists it, Core never interprets it, and only the owning adapter should read
it after resume.

Usage is optional. When known, include it on `response.completed`. This fragment
belongs in the adapter's `stream()`; `message` and `providerUsage` come from the
service's actual response:

```ts
yield {
  type: "response.completed",
  message,
  usage: {
    inputTokens: providerUsage.promptTokens,
    outputTokens: providerUsage.completionTokens,
    totalTokens: providerUsage.totalTokens,
  },
};
```

Do not invent token values. Report only fields supplied or reliably computed
by the provider.

## Optional capabilities

An adapter may expose:

- `limits`, which applications can turn into a Context budget with
  `contextBudgetFromModel()`;
- `contextCompactor`, for a provider-native compaction operation.

Provider-native compaction is optional. `@may/context` adapts it through
`ModelContextCompactionStrategy`; it does not belong in the normal
`stream()` implementation. A compactor should also report the usage of its own
compaction request in `ModelContextCompactionResult.usage`, so a host can account
that request instead of charging a reservation. See
[Custom Context](./custom-context.md).

## Registering a configurable adapter

Applications that use May model profiles can register an instance-scoped
factory with `@may/providers`:

```ts
import { ProviderAdapterRegistry } from "@may/providers";

const registry = new ProviderAdapterRegistry().register("uppercase", {
  create(_selection) {
    return new UppercaseModel();
  },
});
```

The configuration profile's `adapter` must then be `uppercase`. Registration
is not global, duplicate names are rejected, and the product decides which
registries it accepts.

## Built-in protocol and retry behavior

`RetryingModel` preserves the server's `Retry-After` duration. If that duration
exceeds `maxDelayMs`, it returns the original error. Responses errors expose
`providerType` and `providerCode` separately. Invalid Chat Completions tool-argument
JSON raises a protocol error.

A top-level Chat Completions `error` ends processing at that chunk and retains
the server's `message`, `type`, and `code` in the error text. The adapter preserves
that failure through stream termination and emits no `response.completed`.

## Adapter checklist

- Forward cancellation and provider errors.
- Emit one complete response, even when deltas were emitted.
- Preserve tool-call IDs and all supported content parts.
- Keep credentials in provider configuration, never in messages or
  `modelState`.
- Put retry behavior in an explicit adapter/wrapper and emit `retrying` when a
  request is delayed for another attempt.
- Test malformed streams, cancellation, tool-call conversion, and unsupported
  content at the adapter boundary.

Next: [Custom tools](./custom-tool.md) and
[Build an agent](./building-an-agent.md).
