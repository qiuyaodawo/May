# Custom tools

**English** | [简体中文](../../zh-CN/guides/custom-tool.md)

A May tool is one named capability exposed to a model. The `Tool` contract from
`@may/core` separates three concerns:

- `inputSchema` describes the call to the model;
- optional `parse()` validates and converts untrusted model output;
- `execute()` performs the operation.

There is currently no process-global tool registry. Each `May` or
`AgentApplication` receives its own tool array.

## A complete tool

```ts
import type { Tool } from "@may/core";

interface AddInput {
  readonly left: number;
  readonly right: number;
}

interface AddOutput {
  readonly value: number;
}

export const addTool: Tool<AddInput, AddOutput> = {
  name: "add",
  description: "Add two finite numbers.",
  inputSchema: {
    type: "object",
    properties: {
      left: { type: "number" },
      right: { type: "number" },
    },
    required: ["left", "right"],
    additionalProperties: false,
  },

  parse(input): AddInput {
    if (typeof input !== "object" || input === null) {
      throw new TypeError("add input must be an object");
    }
    const value = input as Record<string, unknown>;
    if (!Number.isFinite(value.left) || !Number.isFinite(value.right)) {
      throw new TypeError("left and right must be finite numbers");
    }
    return { left: value.left as number, right: value.right as number };
  },

  async execute(input, context): Promise<AddOutput> {
    context.signal.throwIfAborted();
    context.report({ type: "progress", message: "Adding values" });
    return { value: input.left + input.right };
  },
};
```

Register it when opening an application:

```ts
const application = await AgentApplication.open({
  model,
  store,
  tools: [addTool],
  permissionPolicy,
});
```

`inputSchema` is sent to the model; it is not a runtime validator. Always
validate in `parse()` (or inside `execute()` if no separate parser is useful).
The permission policy receives the parsed value.

## Execution context

Every call receives a `ToolExecutionContext`:

- `runId`, `step`, and `toolCallId` correlate events;
- `idempotencyKey` is stable for that call and should be used when an external
  API supports deduplication;
- `signal` cancels the operation with its owning run;
- `report()` emits live `output.delta` or structured `progress` updates.

Progress is not durable Session history. Return the complete result from
`execute()` and do not rely on a UI retaining every delta.

For long-running work, forward `signal` into every cancellable dependency and
check it between non-cancellable stages:

```ts
async execute(input, context) {
  const response = await fetch(input.url, { signal: context.signal });
  context.signal.throwIfAborted();
  return { status: response.status, body: await response.text() };
}
```

If a side effect may have committed before cancellation, the tool must define
its own recovery or idempotency behavior. May cannot roll external effects
back.

## Failure semantics

A validation or ordinary execution error becomes a `tool.failed` event and an
error tool message. The model can inspect that result on the next step and
recover. Throw `FatalToolExecutionError` only when continuing the run would be
unsafe, such as a broken authorization or persistence boundary.

An aborted run is different from an ordinary tool failure. Once the signal is
aborted, stop producing progress and exit promptly. Core records terminal
results for calls that were cancelled before completion so resumed history
does not contain unmatched tool calls.

Tool names must be unique within a runtime. `May` rejects duplicates. If
`AgentApplication` is configured with the optional `session_history` tool,
that name is reserved by the application.

Core uses the sequential scheduler by default. Only opt into
`parallelToolScheduler` when every tool selected in the same model response is
safe to run concurrently and their results remain meaningful in call order.

## Security boundary

A tool is executable application code, not a sandbox:

- treat model arguments as hostile input;
- bound input size, output size, runtime, retries, and resource use;
- canonicalize filesystem paths and defend against links when enforcing a
  workspace boundary;
- avoid returning credentials or sensitive environment data because tool
  results become model-visible and durable history;
- use least-privilege clients for network and database access;
- place user authorization in a separate permission policy.

Approval controls whether a capability may run; it does not restrict what the
process can access after approval. See
[Permission policies](./permission-policy.md).

For workspace-safe file and shell implementations, prefer the factories in
`@may/coding-tools`. Its shell tool executes with the May process's privileges
and is explicitly **not** a sandbox.

## Testing boundary

Test `parse()` and `execute()` without a model first. Use an
`AbortController`, a fixed execution context, and capture `report()` calls.
Then add one runtime-level test proving that the normalized output is returned
to the model. Provider behavior does not need to be retested by every tool.

See also [Custom model adapters](./custom-model.md) and
[Custom UI](./custom-ui.md).
