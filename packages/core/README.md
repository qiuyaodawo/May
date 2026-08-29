# `@may/core`

The model- and tool-agnostic runtime at the heart of May agents.

It accepts a `Model`, a set of `Tool`s, and a `Context`, executes an agent
loop, and exposes the run as an async event stream.

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
`ModelStreamOptions`. A successful `RunResult` reports `modelCalls`,
`toolCalls`, and token usage aggregated across all completed model calls.

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
