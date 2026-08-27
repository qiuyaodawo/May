import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May, reasoningContent } from "../dist/index.js";

function assistant(text, toolCalls) {
  const message = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
  };
  if (toolCalls) message.toolCalls = toolCalls;
  return message;
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }

  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("aborted")),
      { once: true },
    );
  });
}

function assertSingleTerminalEvent(events, expectedType) {
  const terminals = events.filter((event) =>
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, expectedType);
  assert.equal(events.at(-1), terminals[0]);
}

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
  assert.equal(result.turns, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "turn.started",
      "model.started",
      "model.text.delta",
      "model.completed",
      "turn.completed",
      "run.completed",
    ],
  );
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);

  const snapshot = await context.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
  assert.deepEqual(snapshot.metadata, { tenant: "test" });
});

test("forwards reasoning deltas and preserves reasoning content", async () => {
  const response = {
    role: "assistant",
    content: [
      ...reasoningContent("I should calculate first."),
      { type: "text", text: "The answer is 42." },
    ],
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
    events
      .filter((event) => event.type === "model.reasoning.delta")
      .map((event) => event.delta),
    ["I should calculate first."],
  );
  assert.deepEqual((await context.snapshot()).messages.at(-1), response);
});

test("rejects invalid maxTurns and duplicate tool names at construction", () => {
  const model = { async *stream() {} };
  const context = new InMemoryContext();
  const duplicate = {
    name: "duplicate",
    description: "duplicate",
    inputSchema: {},
    async execute() {},
  };

  assert.throws(
    () => new May({ model, context, maxTurns: 0 }),
    /maxTurns must be a positive integer/,
  );
  assert.throws(
    () => new May({ model, context, tools: [duplicate, duplicate] }),
    /Duplicate tool name: duplicate/,
  );
});

test("executes a tool and feeds its result back to the model", async () => {
  let modelTurn = 0;
  const model = {
    async *stream(request) {
      modelTurn += 1;
      if (modelTurn === 1) {
        assert.equal(request.tools[0].name, "add");
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "call_1", name: "add", input: { a: 2, b: 3 } },
          ]),
        };
        return;
      }

      const toolMessage = request.messages.at(-1);
      assert.equal(toolMessage.role, "tool");
      assert.equal(toolMessage.content[0].value, 5);
      yield {
        type: "response.completed",
        message: assistant("2 + 3 = 5"),
      };
    },
  };

  const add = {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    parse(input) {
      if (
        typeof input !== "object" || input === null ||
        typeof input.a !== "number" || typeof input.b !== "number"
      ) {
        throw new TypeError("a and b must be numbers");
      }
      return input;
    },
    async execute({ a, b }) {
      return a + b;
    },
  };

  const context = new InMemoryContext();
  const run = new May({ model, tools: [add], context }).run({ input: "add" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.turns, 2);
  assert.equal(result.message.content[0].text, "2 + 3 = 5");
  assert.ok(events.some((event) => event.type === "tool.completed"));

  const snapshot = await context.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
});

test("executes multiple tool calls from one model turn in order", async () => {
  let modelTurn = 0;
  const executionOrder = [];
  const model = {
    async *stream(request) {
      modelTurn += 1;
      if (modelTurn === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "first_call", name: "first", input: { value: 1 } },
            { id: "second_call", name: "second", input: { value: 2 } },
          ]),
        };
        return;
      }

      const toolMessages = request.messages.slice(-2);
      assert.deepEqual(toolMessages.map((message) => message.role), ["tool", "tool"]);
      assert.deepEqual(toolMessages.map((message) => message.name), ["first", "second"]);
      assert.deepEqual(
        toolMessages.map((message) => message.content[0].value),
        ["first:1", "second:2"],
      );
      yield {
        type: "response.completed",
        message: assistant("both tools completed"),
      };
    },
  };

  const createTool = (name) => ({
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    async execute(input) {
      executionOrder.push(name);
      return `${name}:${input.value}`;
    },
  });

  const context = new InMemoryContext();
  const run = new May({
    model,
    tools: [createTool("first"), createTool("second")],
    context,
  }).run({ input: "run both" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.turns, 2);
  assert.deepEqual(executionOrder, ["first", "second"]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool.completed")
      .map((event) => event.call.name),
    ["first", "second"],
  );

  const snapshot = await context.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant",
  ]);
});

test("turns a tool parse failure into a tool message and continues", async () => {
  let modelTurn = 0;
  let executeCalled = false;
  const model = {
    async *stream(request) {
      modelTurn += 1;
      if (modelTurn === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "parse_call", name: "strict", input: { value: "wrong" } },
          ]),
        };
        return;
      }

      const errorMessage = request.messages.at(-1);
      assert.equal(errorMessage.role, "tool");
      assert.equal(errorMessage.isError, true);
      assert.equal(errorMessage.content[0].value.name, "TypeError");
      assert.equal(errorMessage.content[0].value.message, "value must be a number");
      yield {
        type: "response.completed",
        message: assistant("invalid input recovered"),
      };
    },
  };

  const strictTool = {
    name: "strict",
    description: "Accept only numeric values",
    inputSchema: { type: "object" },
    parse(input) {
      if (typeof input?.value !== "number") {
        throw new TypeError("value must be a number");
      }
      return input;
    },
    async execute() {
      executeCalled = true;
      return "unreachable";
    },
  };

  const run = new May({
    model,
    tools: [strictTool],
    context: new InMemoryContext(),
  }).run({ input: "parse bad input" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.turns, 2);
  assert.equal(executeCalled, false);
  const failure = events.find((event) => event.type === "tool.failed");
  assert.equal(failure.error.name, "TypeError");
  assertSingleTerminalEvent(events, "run.completed");
});

test("turns a tool execution error into a tool message and continues", async () => {
  let modelTurn = 0;
  const model = {
    async *stream(request) {
      modelTurn += 1;
      if (modelTurn === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "broken_call", name: "broken", input: {} },
          ]),
        };
        return;
      }

      const errorMessage = request.messages.at(-1);
      assert.equal(errorMessage.role, "tool");
      assert.equal(errorMessage.isError, true);
      assert.equal(errorMessage.content[0].value.message, "tool exploded");
      yield {
        type: "response.completed",
        message: assistant("execution failure recovered"),
      };
    },
  };

  const broken = {
    name: "broken",
    description: "Always fails",
    inputSchema: {},
    async execute() {
      throw new Error("tool exploded");
    },
  };

  const run = new May({
    model,
    tools: [broken],
    context: new InMemoryContext(),
  }).run({ input: "run broken tool" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.turns, 2);
  const failure = events.find((event) => event.type === "tool.failed");
  assert.equal(failure.error.message, "tool exploded");
  assertSingleTerminalEvent(events, "run.completed");
});

test("turns an unknown tool into a tool error so the model can recover", async () => {
  let turn = 0;
  const model = {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "missing_1", name: "missing", input: {} },
          ]),
        };
        return;
      }

      const toolMessage = request.messages.at(-1);
      assert.equal(toolMessage.isError, true);
      assert.equal(toolMessage.content[0].value.code, "TOOL_NOT_FOUND");
      yield {
        type: "response.completed",
        message: assistant("I cannot use that tool."),
      };
    },
  };

  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run({ input: "do it" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.turns, 2);
  assert.ok(events.some((event) => event.type === "tool.failed"));
  assert.equal(events.at(-1).type, "run.completed");
});

test("fails when maxTurns is exceeded", async () => {
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("", [
          { id: `call_${Math.random()}`, name: "noop", input: null },
        ]),
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
    maxTurns: 2,
  }).run({ input: "loop" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, { code: "MAX_TURNS_EXCEEDED" });
  const events = await eventPromise;
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).error.code, "MAX_TURNS_EXCEEDED");
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
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user"]);
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

test("run.cancel aborts an active model call", async () => {
  const started = deferred();
  let modelSignal;
  const model = {
    async *stream(_request, { signal }) {
      modelSignal = signal;
      started.resolve();
      await waitForAbort(signal);
    },
  };

  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run({ input: "wait" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop model");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.equal(modelSignal.aborted, true);
  assert.equal(modelSignal.reason, "stop model");
  assert.equal(events.at(-1).reason, "stop model");
  assertSingleTerminalEvent(events, "run.cancelled");
});

test("run.cancel aborts an active tool without turning it into a tool failure", async () => {
  const started = deferred();
  let toolSignal;
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("", [
          { id: "slow_call", name: "slow", input: {} },
        ]),
      };
    },
  };
  const slow = {
    name: "slow",
    description: "Wait until cancelled",
    inputSchema: {},
    async execute(_input, { signal }) {
      toolSignal = signal;
      started.resolve();
      await waitForAbort(signal);
    },
  };

  const run = new May({
    model,
    tools: [slow],
    context: new InMemoryContext(),
  }).run({ input: "start slow tool" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop tool");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason, "stop tool");
  assert.equal(events.some((event) => event.type === "tool.failed"), false);
  assertSingleTerminalEvent(events, "run.cancelled");
});

test("propagates an external AbortSignal into an active model call", async () => {
  const controller = new AbortController();
  const abortReason = new Error("external stop");
  const started = deferred();
  let modelSignal;
  const model = {
    async *stream(_request, { signal }) {
      modelSignal = signal;
      started.resolve();
      await waitForAbort(signal);
    },
  };

  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run({ input: "wait", signal: controller.signal });
  const eventPromise = collect(run.events);

  await started.promise;
  controller.abort(abortReason);

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.equal(modelSignal.aborted, true);
  assert.equal(modelSignal.reason, abortReason);
  assert.equal(events.at(-1).reason, "external stop");
  assertSingleTerminalEvent(events, "run.cancelled");
});

test("a pre-aborted external signal cancels before context mutation", async () => {
  const controller = new AbortController();
  controller.abort(null);

  const context = new InMemoryContext();
  const model = {
    async *stream() {
      assert.fail("model must not be called");
    },
  };
  const run = new May({ model, context }).run({
    input: "must not be appended",
    signal: controller.signal,
  });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "run.cancelled",
  ]);
  assert.equal("reason" in events.at(-1), false);
  assert.deepEqual((await context.snapshot()).messages, []);
  assertSingleTerminalEvent(events, "run.cancelled");
});
