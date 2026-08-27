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

Model adapters emit normalized `text.delta` and `response.completed` events.
Tool failures are converted into tool messages so the model can recover.
Model and Context failures terminate the run.

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
