# Custom model adapters

**English** | [简体中文](../zh-CN/guides/custom-model.md)

A May model adapter translates one provider protocol into the provider-neutral
`Model` contract from `@may/core`. It should not own sessions, permission
prompts, UI state, or product instructions.

Use a built-in adapter from `@may/providers` when the provider is already
supported. Implement `Model` when integrating a new protocol or when creating a
deterministic model for tests.

## Minimal implementation

The following adapter is deliberately local and deterministic, but it is a
complete `Model` and can be copied into an application:

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

It can be supplied directly to the headless application layer:

```ts
import { AgentApplication } from "@may/application";
import { InMemorySessionStore } from "@may/session";

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

Usage is optional. When known, include it on `response.completed`:

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
`stream()` implementation. See [Custom Context](./custom-context.md).

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
