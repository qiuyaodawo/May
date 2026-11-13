import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May, parallelToolScheduler } from "@sortedyuan/may/core";

import { assertSingleTerminalEvent, assistant, collect, deferred, waitForAbort } from "./fixtures/may.mjs";

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
  let modelCall = 0;
  let toolSignal;
  const model = {
    async *stream(request) {
      modelCall += 1;
      if (modelCall > 1) {
        const callIndex = request.messages.findIndex(
          (message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === "slow_call"),
        );
        const cancellation = request.messages[callIndex + 1];
        assert.equal(cancellation.role, "tool");
        assert.equal(cancellation.toolCallId, "slow_call");
        assert.equal(cancellation.isError, true);
        assert.equal(cancellation.content[0].value.code, "RUN_CANCELLED");
        yield {
          type: "response.completed",
          message: assistant("recovered"),
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistant("", [{ id: "slow_call", name: "slow", input: {} }]),
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

  const context = new InMemoryContext();
  const may = new May({
    model,
    tools: [slow],
    context,
  });
  const run = may.run({ input: "start slow tool" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop tool");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;

  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason, "stop tool");
  assert.equal(
    events.some((event) => event.type === "tool.failed"),
    false,
  );
  assertSingleTerminalEvent(events, "run.cancelled");
  assert.deepEqual(
    (await context.snapshot()).messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal((await may.run({ input: "continue" }).result).message.content[0].text, "recovered");
});

test("emits a failed terminal event when cancellation context persistence fails", async () => {
  const started = deferred();
  const inner = new InMemoryContext();
  const context = {
    snapshot: (options) => inner.snapshot(options),
    append(messages, options) {
      if (messages.some((message) => message.role === "tool" && message.content[0]?.value?.code === "RUN_CANCELLED")) {
        return Promise.reject(new Error("context write failed"));
      }
      return inner.append(messages, options);
    },
  };
  const run = new May({
    context,
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistant("", [{ id: "slow_call", name: "slow", input: {} }]),
        };
      },
    },
    tools: [
      {
        name: "slow",
        description: "Wait until cancelled",
        inputSchema: {},
        async execute(_input, { signal }) {
          started.resolve();
          await waitForAbort(signal);
        },
      },
    ],
  }).run({ input: "start" });
  const eventPromise = collect(run.events);

  await started.promise;
  run.cancel("stop");

  await assert.rejects(run.result, /context write failed/u);
  const events = await eventPromise;
  assert.equal(events.find((event) => event.type === "tool.failed").error.code, "RUN_CANCELLED");
  assertSingleTerminalEvent(events, "run.failed");
});

test("cancelling a sequential tool batch preserves completed outcomes", async () => {
  const secondStarted = deferred();
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistant("", [
          { id: "completed_call", name: "complete", input: {} },
          { id: "cancelled_call", name: "slow", input: {} },
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
        name: "complete",
        description: "complete before cancellation",
        inputSchema: {},
        async execute() {
          return { sideEffectCommitted: true };
        },
      },
      {
        name: "slow",
        description: "wait for cancellation",
        inputSchema: {},
        async execute(_input, { signal }) {
          secondStarted.resolve();
          await waitForAbort(signal);
        },
      },
    ],
  }).run({ input: "run both" });
  const eventPromise = collect(run.events);

  await secondStarted.promise;
  run.cancel("stop batch");

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;
  const toolMessages = (await context.snapshot()).messages.slice(-2);

  assert.deepEqual(toolMessages[0].content[0].value, {
    sideEffectCommitted: true,
  });
  assert.equal(toolMessages[0].isError, undefined);
  assert.equal(toolMessages[1].content[0].value.code, "RUN_CANCELLED");
  assert.deepEqual(
    events.filter((event) => event.type === "tool.completed").map((event) => event.call.id),
    ["completed_call"],
  );
  assertSingleTerminalEvent(events, "run.cancelled");
});

test("cancelling parallel tools waits for started side effects to settle", async () => {
  const sideEffectStarted = deferred();
  const releaseSideEffect = deferred();
  let sideEffects = 0;
  const context = new InMemoryContext();
  const run = new May({
    context,
    toolScheduler: parallelToolScheduler,
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistant("", [
            { id: "abort_call", name: "abort", input: {} },
            { id: "effect_call", name: "effect", input: {} },
          ]),
        };
      },
    },
    tools: [
      {
        name: "abort",
        description: "Reject on cancellation",
        inputSchema: {},
        async execute(_input, { signal }) {
          await waitForAbort(signal);
        },
      },
      {
        name: "effect",
        description: "Commit a side effect despite late cancellation",
        inputSchema: {},
        async execute() {
          sideEffectStarted.resolve();
          await releaseSideEffect.promise;
          sideEffects += 1;
          return { sideEffectCommitted: true };
        },
      },
    ],
  }).run({ input: "run in parallel" });
  const eventPromise = collect(run.events);
  let resultSettled = false;
  void run.result
    .finally(() => {
      resultSettled = true;
    })
    .catch(() => undefined);

  await sideEffectStarted.promise;
  run.cancel("stop parallel batch");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resultSettled, false);
  releaseSideEffect.resolve();

  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  const events = await eventPromise;
  assert.equal(sideEffects, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "tool.completed").map((event) => event.call.id),
    ["effect_call"],
  );
  const toolMessages = (await context.snapshot()).messages.slice(-2);
  assert.equal(toolMessages[0].content[0].value.code, "RUN_CANCELLED");
  assert.deepEqual(toolMessages[1].content[0].value, {
    sideEffectCommitted: true,
  });
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

  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "run.cancelled"],
  );
  assert.equal("reason" in events.at(-1), false);
  assert.deepEqual((await context.snapshot()).messages, []);
  assertSingleTerminalEvent(events, "run.cancelled");
});
