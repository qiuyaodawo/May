import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrentRunError, InMemoryContext, May, reasoningContent } from "@sortedyuan/may/core";

import { assertSingleTerminalEvent, assistant, collect, deferred, waitForAbort } from "./fixtures/may.mjs";

test("returns a direct model response and emits ordered events", async () => {
  const model = {
    async *stream(request) {
      assert.equal(request.messages[0].role, "system");
      assert.equal(request.messages[0].content[0].text, "Be concise.");
      assert.equal(request.messages[1].role, "user");
      assert.deepEqual(request.metadata, { tenant: "test" });
      yield { type: "text.delta", delta: "hello" };
      yield {
        type: "response.completed",
        message: assistant("hello"),
        usage: { totalTokens: 3 },
      };
    },
  };

  const context = new InMemoryContext({
    instructions: "Be concise.",
    metadata: { tenant: "test" },
  });
  const run = new May({ model, context }).run({ input: "Hi" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.message.content[0].text, "hello");
  assert.equal(result.steps, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "model.started",
      "model.text.delta",
      "model.completed",
      "step.completed",
      "run.completed",
    ],
  );
  assert.equal(events.find((event) => event.type === "model.completed").contextMessageCount, 1);

  const snapshot = await context.snapshot();
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(snapshot.metadata, { tenant: "test" });
});

test("forwards reasoning deltas and preserves reasoning content", async () => {
  const response = {
    role: "assistant",
    content: [...reasoningContent("I should calculate first."), { type: "text", text: "The answer is 42." }],
  };
  const model = {
    async *stream() {
      yield { type: "reasoning.delta", delta: "I should calculate first." };
      yield { type: "text.delta", delta: "The answer is 42." };
      yield { type: "response.completed", message: response };
    },
  };

  const context = new InMemoryContext();
  const run = new May({ model, context }).run({ input: "think" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.deepEqual(result.message, response);
  assert.deepEqual(
    events.filter((event) => event.type === "model.reasoning.delta").map((event) => event.delta),
    ["I should calculate first."],
  );
  assert.deepEqual((await context.snapshot()).messages.at(-1), response);
});

test("forwards model retry events with run and step metadata", async () => {
  const model = {
    async *stream() {
      yield {
        type: "retrying",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        error: { name: "Error", message: "temporarily unavailable" },
      };
      yield {
        type: "response.completed",
        message: assistant("recovered"),
      };
    },
  };
  const run = new May({ model, context: new InMemoryContext() }).run({
    input: "retry",
  });
  const eventPromise = collect(run.events);
  await run.result;
  const retry = (await eventPromise).find((event) => event.type === "model.retrying");

  assert.deepEqual(retry, {
    type: "model.retrying",
    runId: run.id,
    seq: 4,
    timestamp: retry.timestamp,
    step: 1,
    attempt: 2,
    maxAttempts: 3,
    delayMs: 250,
    error: { name: "Error", message: "temporarily unavailable" },
  });
});

test("continues existing context without appending a new user message", async () => {
  let request;
  const model = {
    async *stream(value) {
      request = value;
      yield {
        type: "response.completed",
        message: assistant("continued"),
      };
    },
  };
  const original = {
    role: "user",
    content: [{ type: "text", text: "original" }],
  };
  const context = new InMemoryContext({ messages: [original] });
  const run = new May({ model, context }).continue();
  const eventPromise = collect(run.events);

  await run.result;
  const events = await eventPromise;

  assert.deepEqual(request.messages, [original]);
  assert.equal(events[0].type, "run.started");
  assert.equal(events[0].continuation, true);
  assert.deepEqual(
    (await context.snapshot()).messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("preserves opaque model state across steps and runs", async () => {
  const firstState = {
    type: "test.provider/response-v1",
    data: { responseId: "response_1", signature: "signed" },
  };
  const secondState = {
    type: "test.provider/response-v1",
    data: { responseId: "response_2" },
  };
  let modelCall = 0;
  const model = {
    async *stream(request) {
      modelCall += 1;

      if (modelCall === 1) {
        yield {
          type: "response.completed",
          message: {
            ...assistant("", [{ id: "state_call", name: "noop", input: {} }]),
            modelState: firstState,
          },
        };
        return;
      }

      const previousAssistant = request.messages.filter((message) => message.role === "assistant").at(-1);

      if (modelCall === 2) {
        assert.deepEqual(previousAssistant.modelState, firstState);
        yield {
          type: "response.completed",
          message: {
            ...assistant("first run complete"),
            modelState: secondState,
          },
        };
        return;
      }

      assert.deepEqual(previousAssistant.modelState, secondState);
      yield {
        type: "response.completed",
        message: assistant("second run complete"),
      };
    },
  };
  const noop = {
    name: "noop",
    description: "No operation",
    inputSchema: {},
    async execute() {
      return null;
    },
  };
  const context = new InMemoryContext();
  const may = new May({ model, tools: [noop], context });

  const firstRun = may.run({ input: "first" });
  const firstEventsPromise = collect(firstRun.events);
  const firstResult = await firstRun.result;
  const firstEvents = await firstEventsPromise;

  assert.deepEqual(firstResult.message.modelState, secondState);
  assert.deepEqual(
    firstEvents.filter((event) => event.type === "model.completed").map((event) => event.message.modelState),
    [firstState, secondState],
  );

  const secondRun = may.run({ input: "second" });
  const secondEventsPromise = collect(secondRun.events);
  await secondRun.result;
  await secondEventsPromise;

  const assistantMessages = (await context.snapshot()).messages.filter((message) => message.role === "assistant");
  assert.deepEqual(assistantMessages[0].modelState, firstState);
  assert.deepEqual(assistantMessages[1].modelState, secondState);
  assert.equal(modelCall, 3);
});

test("fails when maxSteps is exceeded", async () => {
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("", [{ id: `call_${Math.random()}`, name: "noop", input: null }]),
      };
    },
  };

  const noop = {
    name: "noop",
    description: "No operation",
    inputSchema: {},
    async execute() {
      return null;
    },
  };

  const run = new May({
    model,
    tools: [noop],
    context: new InMemoryContext(),
    maxSteps: 2,
  }).run({ input: "loop" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, { code: "MAX_STEPS_EXCEEDED" });
  const events = await eventPromise;
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).error.code, "MAX_STEPS_EXCEEDED");
});

test("fails when the model stream ends without response.completed", async () => {
  const model = {
    async *stream() {
      yield { type: "text.delta", delta: "partial" };
    },
  };

  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run({ input: "incomplete response" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, { code: "MODEL_PROTOCOL_ERROR" });
  const events = await eventPromise;

  assert.equal(events.at(-1).error.code, "MODEL_PROTOCOL_ERROR");
  assertSingleTerminalEvent(events, "run.failed");
});

test("fails when the model emits response.completed more than once", async () => {
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("first"),
      };
      yield {
        type: "response.completed",
        message: assistant("second"),
      };
    },
  };

  const context = new InMemoryContext();
  const run = new May({ model, context }).run({ input: "duplicate response" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, { code: "MODEL_PROTOCOL_ERROR" });
  const events = await eventPromise;

  assertSingleTerminalEvent(events, "run.failed");
  const snapshot = await context.snapshot();
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    ["user"],
  );
});

test("emits exactly one failed terminal event when the model throws", async () => {
  const model = {
    async *stream() {
      throw new Error("provider unavailable");
    },
  };

  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run({ input: "hello" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, /provider unavailable/);
  const events = await eventPromise;

  assert.equal(events.at(-1).error.message, "provider unavailable");
  assertSingleTerminalEvent(events, "run.failed");
});

test("emits exactly one failed terminal event when the context throws", async () => {
  const context = {
    async append() {},
    async snapshot() {
      throw new Error("context unavailable");
    },
  };
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("unreachable"),
      };
    },
  };

  const run = new May({ model, context }).run({ input: "hello" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, /context unavailable/);
  const events = await eventPromise;

  assert.equal(events.at(-1).error.message, "context unavailable");
  assertSingleTerminalEvent(events, "run.failed");
});

test("rejects concurrent runs against the same runtime context", async () => {
  const started = deferred();
  const model = {
    async *stream(_request, { signal }) {
      started.resolve();
      await waitForAbort(signal);
    },
  };
  const may = new May({ model, context: new InMemoryContext() });
  const first = may.run({ input: "first" });
  const eventPromise = collect(first.events);
  await started.promise;

  assert.throws(() => may.run({ input: "second" }), ConcurrentRunError);
  first.cancel("done");
  await assert.rejects(first.result, { code: "RUN_CANCELLED" });
  await eventPromise;
});

test("bounds unconsumed streaming events without losing lifecycle events", async () => {
  const model = {
    async *stream() {
      for (let index = 0; index < 20; index++) {
        yield { type: "text.delta", delta: String(index) };
      }
      yield {
        type: "response.completed",
        message: assistant("complete"),
      };
    },
  };
  const run = new May({
    model,
    context: new InMemoryContext(),
    maxBufferedEvents: 4,
  }).run({ input: "stream" });

  await run.result;
  const events = await collect(run.events);

  assert.equal(
    events.some((event) => event.type === "model.text.delta"),
    false,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "step.started", "model.started", "model.completed", "step.completed", "run.completed"],
  );
  assert.ok(events.some((event, index) => index > 0 && event.seq > events[index - 1].seq + 1));
});
