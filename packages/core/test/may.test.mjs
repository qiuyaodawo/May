import assert from "node:assert/strict";
import test from "node:test";

import {
  directToolExecutor,
  InMemoryContext,
  May,
  reasoningContent,
} from "../dist/index.js";

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
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(
    events.find((event) => event.type === "model.completed")
      .contextMessageCount,
    1,
  );

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

test("rejects invalid maxSteps and duplicate tool names at construction", () => {
  const model = { async *stream() {} };
  const context = new InMemoryContext();
  const duplicate = {
    name: "duplicate",
    description: "duplicate",
    inputSchema: {},
    async execute() {},
  };

  assert.throws(
    () => new May({ model, context, maxSteps: 0 }),
    /maxSteps must be a positive integer/,
  );
  assert.throws(
    () => new May({ model, context, tools: [duplicate, duplicate] }),
    /Duplicate tool name: duplicate/,
  );
});

test("executes a tool and feeds its result back to the model", async () => {
  let modelStep = 0;
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
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

  assert.equal(result.steps, 2);
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

test("routes parsed tool calls through a custom executor", async () => {
  let modelStep = 0;
  let observedExecution;
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "double_call", name: "double", input: { value: "4" } },
          ]),
        };
        return;
      }

      assert.equal(request.messages.at(-1).content[0].value, 8);
      yield {
        type: "response.completed",
        message: assistant("4 doubled is 8"),
      };
    },
  };
  const double = {
    name: "double",
    description: "Double a number",
    inputSchema: { type: "object" },
    parse(input) {
      return { value: Number(input.value) };
    },
    async execute({ value }) {
      return value * 2;
    },
  };
  const toolExecutor = {
    async execute(execution) {
      observedExecution = execution;
      return directToolExecutor.execute(execution);
    },
  };

  const run = new May({
    model,
    tools: [double],
    context: new InMemoryContext(),
    toolExecutor,
  }).run({ input: "double four" });
  const result = await run.result;

  assert.equal(result.steps, 2);
  assert.equal(observedExecution.tool, double);
  assert.deepEqual(observedExecution.input, { value: 4 });
  assert.equal(observedExecution.context.runId, run.id);
  assert.equal(observedExecution.context.step, 1);
  assert.equal(
    observedExecution.context.idempotencyKey,
    `${run.id}:1:double_call`,
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
            ...assistant("", [
              { id: "state_call", name: "noop", input: {} },
            ]),
            modelState: firstState,
          },
        };
        return;
      }

      const previousAssistant = request.messages
        .filter((message) => message.role === "assistant")
        .at(-1);

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
    firstEvents
      .filter((event) => event.type === "model.completed")
      .map((event) => event.message.modelState),
    [firstState, secondState],
  );

  const secondRun = may.run({ input: "second" });
  const secondEventsPromise = collect(secondRun.events);
  await secondRun.result;
  await secondEventsPromise;

  const assistantMessages = (await context.snapshot()).messages
    .filter((message) => message.role === "assistant");
  assert.deepEqual(assistantMessages[0].modelState, firstState);
  assert.deepEqual(assistantMessages[1].modelState, secondState);
  assert.equal(modelCall, 3);
});

test("executes multiple tool calls from one model step in order", async () => {
  let modelStep = 0;
  const executionOrder = [];
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
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

  assert.equal(result.steps, 2);
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
  let modelStep = 0;
  let executeCalled = false;
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
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

  assert.equal(result.steps, 2);
  assert.equal(executeCalled, false);
  const failure = events.find((event) => event.type === "tool.failed");
  assert.equal(failure.error.name, "TypeError");
  assertSingleTerminalEvent(events, "run.completed");
});

test("turns a tool execution error into a tool message and continues", async () => {
  let modelStep = 0;
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
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

  assert.equal(result.steps, 2);
  const failure = events.find((event) => event.type === "tool.failed");
  assert.equal(failure.error.message, "tool exploded");
  assertSingleTerminalEvent(events, "run.completed");
});

test("turns a custom executor error into a tool message and continues", async () => {
  let modelStep = 0;
  const model = {
    async *stream(request) {
      modelStep += 1;
      if (modelStep === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "blocked_call", name: "blocked", input: {} },
          ]),
        };
        return;
      }

      const toolMessage = request.messages.at(-1);
      assert.equal(toolMessage.isError, true);
      assert.equal(
        toolMessage.content[0].value.message,
        "executor unavailable",
      );
      yield {
        type: "response.completed",
        message: assistant("executor failure recovered"),
      };
    },
  };
  const blocked = {
    name: "blocked",
    description: "Must be intercepted",
    inputSchema: {},
    async execute() {
      assert.fail("the raw tool must not execute");
    },
  };
  const toolExecutor = {
    async execute() {
      throw new Error("executor unavailable");
    },
  };

  const run = new May({
    model,
    tools: [blocked],
    context: new InMemoryContext(),
    toolExecutor,
  }).run({ input: "run blocked tool" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.steps, 2);
  assert.equal(
    events.find((event) => event.type === "tool.failed").error.message,
    "executor unavailable",
  );
  assertSingleTerminalEvent(events, "run.completed");
});

test("turns an unknown tool into a tool error so the model can recover", async () => {
  let step = 0;
  const model = {
    async *stream(request) {
      step += 1;
      if (step === 1) {
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

  assert.equal(result.steps, 2);
  assert.ok(events.some((event) => event.type === "tool.failed"));
  assert.equal(events.at(-1).type, "run.completed");
});

test("fails when maxSteps is exceeded", async () => {
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

test("passes run metadata and cancellation to context snapshots", async () => {
  let snapshotOptions;
  const context = {
    messages: [],
    async append(messages) {
      this.messages.push(...messages);
    },
    async snapshot(options) {
      snapshotOptions = options;
      return { messages: [...this.messages] };
    },
  };
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("done"),
      };
    },
  };

  const run = new May({ model, context }).run({ input: "hello" });
  await run.result;

  assert.equal(snapshotOptions.runId, run.id);
  assert.equal(snapshotOptions.step, 1);
  assert.ok(snapshotOptions.signal instanceof AbortSignal);
});

test("run.cancel aborts active context preparation before the model call", async () => {
  const started = deferred();
  let snapshotSignal;
  let modelCalled = false;
  const context = {
    async append() {},
    async snapshot({ signal }) {
      snapshotSignal = signal;
      started.resolve();
      await waitForAbort(signal);
      return { messages: [] };
    },
  };
  const model = {
    async *stream() {
      modelCalled = true;
      yield {
        type: "response.completed",
        message: assistant("unreachable"),
      };
    },
  };
  const run = new May({ model, context }).run({ input: "wait" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop context");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;
  assert.equal(snapshotSignal.aborted, true);
  assert.equal(snapshotSignal.reason, "stop context");
  assert.equal(modelCalled, false);
  assertSingleTerminalEvent(events, "run.cancelled");
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

test("run.cancel aborts an active custom tool executor", async () => {
  const started = deferred();
  let executorSignal;
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("", [
          { id: "executor_call", name: "noop", input: {} },
        ]),
      };
    },
  };
  const noop = {
    name: "noop",
    description: "Must be intercepted",
    inputSchema: {},
    async execute() {
      assert.fail("the raw tool must not execute");
    },
  };
  const toolExecutor = {
    async execute({ context }) {
      executorSignal = context.signal;
      started.resolve();
      await waitForAbort(context.signal);
    },
  };

  const run = new May({
    model,
    tools: [noop],
    context: new InMemoryContext(),
    toolExecutor,
  }).run({ input: "wait in executor" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop executor");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.equal(executorSignal.aborted, true);
  assert.equal(executorSignal.reason, "stop executor");
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
