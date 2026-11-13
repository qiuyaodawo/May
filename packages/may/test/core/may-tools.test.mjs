import assert from "node:assert/strict";
import test from "node:test";

import {
  directToolExecutor,
  FatalToolExecutionError,
  InMemoryContext,
  May,
  parallelToolScheduler,
} from "@sortedyuan/may/core";

import { assertSingleTerminalEvent, assistant, collect, deferred } from "./fixtures/may.mjs";

test("unresponsive tools have a bounded drain and cannot silently release execution authority", async () => {
  const started = deferred();
  const blocked = deferred();
  const context = new InMemoryContext();
  const may = new May({
    context,
    toolSettleTimeoutMs: 20,
    tools: [
      {
        name: "hang",
        description: "hang",
        inputSchema: {},
        execute() {
          started.resolve();
          return blocked.promise;
        },
      },
    ],
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistant("", [{ id: "a", name: "hang", input: {} }]) };
      },
    },
  });
  const run = may.run({ input: "go" });
  await started.promise;
  run.cancel();
  await assert.rejects(run.result, { code: "RUN_CHECKPOINT_FAILED" });
  assert.throws(() => may.continue(), { code: "RUN_CHECKPOINT_FAILED" });
  blocked.resolve("late");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await context.snapshot()).messages.filter((message) => message.role === "tool").length, 0);
});

test("scheduler errors preserve completed tool outcomes in call order", async () => {
  const context = new InMemoryContext();
  const may = new May({
    context,
    tools: [{ name: "work", description: "work", inputSchema: {}, execute: async () => "done" }],
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "a", name: "work", input: {} },
            { id: "b", name: "work", input: {} },
          ]),
        };
      },
    },
    toolScheduler: {
      async schedule(operations) {
        const values = await Promise.all(operations.map((operation) => operation.execute()));
        return values.reverse();
      },
    },
  });
  await assert.rejects(may.run({ input: "go" }).result, /call order/);
  assert.deepEqual(
    (await context.snapshot()).messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
    ["a", "b"],
  );
});

test("executes a tool and feeds its result back to the model", async () => {
  let modelStep = 0;
  const modelOptions = [];
  const model = {
    async *stream(request, options) {
      modelStep += 1;
      modelOptions.push(options);
      if (modelStep === 1) {
        assert.equal(request.tools[0].name, "add");
        yield {
          type: "response.completed",
          message: assistant("", [{ id: "call_1", name: "add", input: { a: 2, b: 3 } }]),
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
        return;
      }

      const toolMessage = request.messages.at(-1);
      assert.equal(toolMessage.role, "tool");
      assert.equal(toolMessage.content[0].value, 5);
      yield {
        type: "response.completed",
        message: assistant("2 + 3 = 5"),
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
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
      if (typeof input !== "object" || input === null || typeof input.a !== "number" || typeof input.b !== "number") {
        throw new TypeError("a and b must be numbers");
      }
      return input;
    },
    async execute({ a, b }, context) {
      context.report({ type: "progress", message: "adding" });
      context.report({ type: "output.delta", channel: "result", delta: "5" });
      return a + b;
    },
  };

  const context = new InMemoryContext();
  const run = new May({ model, tools: [add], context }).run({ input: "add" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.steps, 2);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    outputTokens: 5,
    totalTokens: 35,
  });
  assert.equal(result.message.content[0].text, "2 + 3 = 5");
  assert.ok(events.some((event) => event.type === "tool.completed"));
  assert.equal(events.find((event) => event.type === "tool.progress").message, "adding");
  assert.equal(events.find((event) => event.type === "tool.output.delta").delta, "5");
  assert.deepEqual(
    modelOptions.map((options) => ({
      runId: options.runId,
      step: options.step,
      modelCallId: options.modelCallId,
    })),
    [
      { runId: run.id, step: 1, modelCallId: `${run.id}:model:1` },
      { runId: run.id, step: 2, modelCallId: `${run.id}:model:2` },
    ],
  );

  const snapshot = await context.snapshot();
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
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
          message: assistant("", [{ id: "double_call", name: "double", input: { value: "4" } }]),
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
  assert.notEqual(observedExecution.tool, double);
  assert.equal(observedExecution.tool.name, double.name);
  assert.ok(Object.isFrozen(observedExecution.tool));
  assert.deepEqual(observedExecution.input, { value: 4 });
  assert.equal(observedExecution.context.runId, run.id);
  assert.equal(observedExecution.context.step, 1);
  assert.equal(observedExecution.context.idempotencyKey, `${run.id}:1:double_call`);
});

test("can schedule tools in parallel while preserving result order", async () => {
  let modelStep = 0;
  const executionOrder = [];
  const allStarted = deferred();
  let started = 0;
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
      assert.deepEqual(
        toolMessages.map((message) => message.role),
        ["tool", "tool"],
      );
      assert.deepEqual(
        toolMessages.map((message) => message.name),
        ["first", "second"],
      );
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
      started += 1;
      if (started === 2) allStarted.resolve();
      await allStarted.promise;
      return `${name}:${input.value}`;
    },
  });

  const context = new InMemoryContext();
  const run = new May({
    model,
    tools: [createTool("first"), createTool("second")],
    context,
    toolScheduler: parallelToolScheduler,
  }).run({ input: "run both" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.steps, 2);
  assert.deepEqual(executionOrder, ["first", "second"]);
  assert.deepEqual(
    events.filter((event) => event.type === "tool.completed").map((event) => event.call.name),
    ["first", "second"],
  );

  const snapshot = await context.snapshot();
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
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
          message: assistant("", [{ id: "parse_call", name: "strict", input: { value: "wrong" } }]),
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
          message: assistant("", [{ id: "broken_call", name: "broken", input: {} }]),
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

test("terminates the run for explicitly fatal tool infrastructure errors", async () => {
  let modelCalls = 0;
  let laterToolExecuted = false;
  const model = {
    async *stream() {
      modelCalls += 1;
      yield {
        type: "response.completed",
        message: assistant("", [
          { id: "fatal_call", name: "fatal", input: {} },
          { id: "later_call", name: "later", input: {} },
        ]),
      };
    },
  };
  const context = new InMemoryContext();
  const run = new May({
    model,
    context,
    tools: [
      {
        name: "fatal",
        description: "fatal infrastructure failure",
        inputSchema: {},
        async execute() {
          throw new FatalToolExecutionError("durability unavailable");
        },
      },
      {
        name: "later",
        description: "must not run after a fatal failure",
        inputSchema: {},
        async execute() {
          laterToolExecuted = true;
          return "unexpected";
        },
      },
    ],
  }).run({ input: "fail" });
  const eventPromise = collect(run.events);

  await assert.rejects(run.result, FatalToolExecutionError);
  const events = await eventPromise;

  assert.equal(modelCalls, 1);
  assert.equal(events.find((event) => event.type === "tool.failed").error.code, "FATAL_TOOL_EXECUTION");
  assert.equal(laterToolExecuted, false);
  assert.deepEqual(
    events.filter((event) => event.type === "tool.started").map((event) => event.call.id),
    ["fatal_call"],
  );
  const toolMessages = (await context.snapshot()).messages.slice(-2);
  assert.equal(toolMessages[0].isError, true);
  assert.equal(toolMessages[1].toolCallId, "later_call");
  assert.equal(toolMessages[1].content[0].value.code, "TOOL_SKIPPED");
  assertSingleTerminalEvent(events, "run.failed");
});

test("turns an unknown tool into a tool error so the model can recover", async () => {
  let step = 0;
  const model = {
    async *stream(request) {
      step += 1;
      if (step === 1) {
        yield {
          type: "response.completed",
          message: assistant("", [{ id: "missing_1", name: "missing", input: {} }]),
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
