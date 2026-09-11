# `@may/core`

The model- and tool-agnostic runtime at the heart of May agents.

It accepts a `Model`, an iterable of `Tool`s, and a `Context`, executes an agent
loop, and exposes the run as an async event stream.

`run()` and `continue()` accept an optional synchronous host `shouldYield`
callback. It is checked only after a complete model/tool step: all started tools
settle and all tool results enter Context before yielding. Yield checkpoints
`run.yielded` before emitting that terminal event and resolves the Run with
`finishReason: "yielded"`. It is not task completion or cancellation. Core does
not schedule wakeups or replay the step; the caller owns subsequent Runs. With no
callback, normal execution is unchanged. See the [coordination guide](../../docs/en/guides/coordination.md)
for slot-releasing subagent waits above Core.

```ts
import { InMemoryContext, May } from "@may/core";

const may = new May({
  model,
  tools: [weatherTool],
  context: new InMemoryContext({
    instructions: "You are May.",
  }),
});

const run = may.run({ input: "What is the weather?" });

for await (const event of run.events) {
  console.log(event);
}

const result = await run.result;
```

`May` consumes and snapshots the tool iterable in its constructor. Later
changes to the source iterable do not change an existing runtime.

## Tool registry

`ToolRegistry` is an instance-scoped, insertion-ordered composition helper. It
implements `Iterable<Tool>`, so it can be passed anywhere May accepts tools;
there is no process-global registry.

```ts
import { ToolRegistry } from "@may/core";

const tools = new ToolRegistry([readTool])
  .register(writeTool)
  .registerAll([searchTool, fetchTool]);

const may = new May({ model, tools, context });
```

The constructor, `register()`, and `registerAll()` validate tools and reject
duplicate names with `DuplicateToolNameError`. `registerAll()` is atomic: if
any incoming tool is invalid or conflicts with the registry or its incoming
group, none of that group is added.

Registry operations are:

- `has(name)`, `get(name)`, and `require(name)` for lookup; `require()` throws
  `ToolNotFoundError` when the name is absent;
- `size`, `names()`, and `values()` for insertion-ordered snapshots;
- `definitions()` for model-facing definitions without executable callbacks;
- `clone()` for an independent registry with the same tools;
- iteration for direct use as `Iterable<Tool>`; and
- `ToolRegistry.compose(...sources)` for duplicate-safe composition of tool
  iterables into a new registry.

Registries snapshot collection membership and descriptor values/references,
but intentionally return each original Tool object. Preserving identity lets
products associate metadata with a Tool through a `WeakMap` or other
identity-based mechanism. The `name`, `description`, and `inputSchema` fields
are readonly in TypeScript; those fields plus `parse` and `execute` must remain
stable after registration.

Operations that return a Tool or model definition verify that its `name`,
`description`, `inputSchema` reference, `parse`, and `execute` still match the
registered descriptor and throw `TypeError` if not. This is a shallow
integrity check, not a clone or deep freeze: mutating properties inside the
same schema object is not detected, so schemas should also be treated as
immutable.

## Tool execution

May validates tool input and sends the parsed call through a `ToolExecutor`.
The default `directToolExecutor` calls the tool directly. Applications can
supply another executor to add cross-cutting behavior without changing tools:

```ts
import { directToolExecutor, May } from "@may/core";

const toolExecutor = {
  async execute(execution) {
    console.log(`Executing ${execution.tool.name}`);
    return directToolExecutor.execute(execution);
  },
};

const may = new May({ model, tools, context, toolExecutor });
```

Permission checks, approvals, timeouts, and tracing can use this seam. Core
does not impose any of those policies itself.

Model adapters emit normalized `text.delta` and `response.completed` events.
Ordinary tool failures are converted into tool messages so the model can
recover. Infrastructure that cannot safely continue can throw
`FatalToolExecutionError` to terminate the run after the failed tool outcome is
recorded.

Tools can report live, non-durable output or progress through their execution
context:

```ts
async execute(input, context) {
  context.report({ type: "progress", message: "starting" });
  context.report({ type: "output.delta", channel: "stdout", delta: "..." });
  return result;
}
```

Multiple calls in one model response run sequentially by default. Supply a
custom `ToolScheduler`, or `parallelToolScheduler` when all selected tools are
safe to run concurrently. Schedulers must return outcomes in call order; Core
also ensures each operation executes at most once.

## Runs and observability

A `May` instance rejects overlapping runs by default because it owns one
mutable `Context`. `concurrentRuns: "allow"` is an explicit escape hatch for a
context implementation that provides its own isolation or serialization.

Each model call receives `runId`, `step`, and a retry-stable `modelCallId` in
`ModelStreamOptions`. When a tracer is configured it also receives the current
`traceContext`; tools receive their tool-call context through
`ToolExecutionContext`. A successful `RunResult` reports `modelCalls`,
`toolCalls`, and token usage aggregated across all completed model calls.

Core exports the minimal `Tracer`, `TraceSpan`, `TraceContext`, and attribute
contracts. Supply `tracer` and optional content-free `traceAttributes` to
`May`; `RunOptions` can add attributes or an explicit parent context, and the
returned `RunHandle` exposes the created context. Built-in instrumentation
creates Run, Context, model, tool-batch, and tool-call spans. Calls into an
injected tracer are protected so telemetry failure never becomes a Run
failure. Sampling, buffering, and exporters live in optional
`@may/observability`; see the
[tracing guide](../../docs/en/guides/observability.md).

Live event queues retain at most `maxBufferedEvents` high-volume streaming
events by default. When a consumer falls behind, text, reasoning, tool-output,
and tool-progress deltas may be discarded before lifecycle events. Event
sequence-number gaps make this observable; the result promise and durable
context are unaffected.

## Content

`ContentPart` provides normalized text, reasoning, JSON, image, audio, file,
and resource parts. Media may be supplied by URL, base64 data, or a
provider-owned file id. Provider adapters convert only the forms their API
supports and throw `UnsupportedContentError` for unsupported role/type pairs;
Core does not silently stringify or discard rich input.

## Model state

An adapter can attach opaque continuation data to an assistant message:

```ts
const message = {
  role: "assistant",
  content: [],
  modelState: {
    type: "@may/provider-example/response-v1",
    data: { responseId: "response_123" },
  },
};
```

`type` should be namespaced and versioned by the adapter. May persists the state
with the message and passes it back in later `ModelRequest.messages`, but never
interprets it. This lets adapters preserve provider-specific continuation data,
such as response IDs or signed reasoning blocks, while normalized content
remains available to other providers.

## Per-Run dynamic tool catalogs

`MayOptions.toolSource`, also forwarded by `AgentApplication`, `defineAgent()`
and `MaybeCodeApplication`, is a trusted synchronous `() => Iterable<Tool>`.
It adds to static `tools`; it is called exactly once at each `run()` or
`continue()` start, not on every model step. Duplicate names fail before Context
mutation. Fetch/discover remote catalogs outside Core and publish their latest
in-memory snapshot through this callback.

`ToolRegistry.snapshot()` captures a frozen Tool facade and a deep-copied,
frozen schema. A Run uses the same snapshot for model definitions, scheduler,
parser, permissions and execution. Model-facing schemas are separate copies.
Updates affect only the next Run. Ordinary registry lookup/`clone()` still
preserve original Tool identity, but executors receive the Run facade: attach
host metadata as Tool fields, not only in an identity-keyed WeakMap. Captured
callbacks retain their original `this`; this is not a sandbox or a deep clone
of arbitrary closure state. Tool schema values must support structured cloning.

`Tool.permissionVersion` is optional host-owned grant identity, omitted from
model definitions. Permission session grants are now bound to canonical name,
description, input schema and this version as well as the policy's `grantKey`.
Changed definitions or host identity require new approval even with the same
key. Equivalent schema key order does not. `revokeSessionGrant(key)` revokes all
versions under that key; explicit policy deny still wins. Host adapters should
include other execution-affecting fields and endpoint/account in their version.

`Tool.resultContent(output)` optionally projects a result to model-visible
`ContentPart[]` (including media). Run snapshots capture the callback; raw output
remains in tool events. Projection failures become tool failures.

`MayOptions.toolScope()` snapshots optional trusted string labels per Run/continue
as `ToolExecutionContext.scope`. Labels are host-only routing data, not model
arguments or protocol capabilities, and do not replace permission policy.
