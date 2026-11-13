import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May, RunCancelledError } from "@sortedyuan/may/core";
import { PermissionToolExecutor } from "@sortedyuan/may/permissions";
import { InMemorySessionStore, Session } from "@sortedyuan/may/session";

import { assistantMessage, createRuntime } from "./fixtures/runtime.mjs";

test("relays live run events and stores only durable session facts", async () => {
  const model = {
    async *stream() {
      yield { type: "text.delta", delta: "hello" };
      yield {
        type: "response.completed",
        message: assistantMessage("hello"),
        usage: { totalTokens: 2 },
      };
    },
  };
  const session = await Session.create({
    requestRecording: "off",
    id: "session_events",
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const run = await session.submit({ input: "hi" });
  const eventsPromise = collect(run.events);
  const result = await run.result;
  const events = await eventsPromise;

  assert.equal(result.message.content[0].text, "hello");
  assert.ok(events.some((event) => event.type === "model.text.delta"));
  assert.deepEqual(
    (await session.history()).map((event) => event.type),
    ["session.created", "input.submitted", "run.started", "assistant.completed", "run.completed", "run.settled"],
  );

  const assistantEvent = (await session.history()).find((event) => event.type === "assistant.completed");
  assert.deepEqual(assistantEvent.usage, { totalTokens: 2 });
  const page = await session.queryHistory({
    order: "desc",
    limit: 2,
    types: ["input.submitted", "assistant.completed"],
  });
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["assistant.completed", "input.submitted"],
  );
  assert.equal(page.hasMore, false);
});

test("serializes submissions and preserves context between runs", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }

      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${requests.length}`),
      };
    },
  };
  const session = await Session.create({
    requestRecording: "off",
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const first = await session.submit({ input: "first" });
  await firstStarted.promise;

  let secondStarted = false;
  const secondSubmission = session.submit({ input: "second" }).then((run) => {
    secondStarted = true;
    return run;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);

  releaseFirst.resolve();
  await first.result;
  const second = await secondSubmission;
  await second.result;

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(requests[1].messages[0].content[0].text, "first");
  assert.equal(requests[1].messages[2].content[0].text, "second");
});

test("stores successful and failed tool outcomes", async () => {
  const store = new InMemorySessionStore();
  const output = { value: 1, _meta: { owner: "host-only-result" } };
  const projected = [
    { type: "text", text: "Public result" },
    { type: "json", value: { value: 1 } },
  ];
  let step = 0;
  const model = {
    async *stream() {
      step += 1;
      if (step === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [
              { id: "call_ok", name: "ok", input: {} },
              { id: "call_fail", name: "fail", input: {} },
            ],
          },
        };
        return;
      }

      yield {
        type: "response.completed",
        message: assistantMessage("done"),
      };
    },
  };
  const session = await Session.create({
    requestRecording: "off",
    store,
    runtime: new May({
      model,
      context: new InMemoryContext(),
      tools: [
        {
          name: "ok",
          description: "Succeeds",
          inputSchema: { type: "object" },
          async execute() {
            return output;
          },
          resultContent() {
            return projected;
          },
        },
        {
          name: "fail",
          description: "Fails",
          inputSchema: { type: "object" },
          async execute() {
            throw new Error("tool failed");
          },
        },
      ],
    }),
  });

  const run = await session.submit({ input: "use tools" });
  await run.result;
  await session.recordToolPresentation({
    runId: run.id,
    step: 1,
    toolCallId: "call_ok",
    kind: "test.preview",
    version: 1,
    data: { label: "preview" },
  });
  const history = await session.history();
  const toolEvents = history.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");

  assert.equal(toolEvents[0].type, "tool.completed");
  assert.deepEqual(toolEvents[0].output, output);
  assert.deepEqual(toolEvents[0].content, projected);
  assert.equal(toolEvents[1].type, "tool.failed");
  assert.equal(toolEvents[1].error.message, "tool failed");
  assert.deepEqual(history.find((event) => event.type === "tool.presentation").data, { label: "preview" });

  let replayed;
  await Session.resume({
    requestRecording: "off",
    id: session.id,
    store,
    createRuntime(messages) {
      replayed = messages;
      return createRuntime();
    },
  });
  assert.deepEqual(
    replayed.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
  assert.deepEqual(replayed[2].content, projected);
  assert.doesNotMatch(JSON.stringify(replayed), /host-only-result/);
  assert.equal(replayed[3].isError, true);
  assert.equal(replayed[3].content[0].value.message, "tool failed");
});

test("records approval decisions before their tool outcomes", async () => {
  let modelCall = 0;
  const model = {
    async *stream() {
      modelCall += 1;
      if (modelCall === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{ id: "call_write", name: "write", input: { path: "a.txt" } }],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage("written"),
      };
    },
  };
  const permissions = new PermissionToolExecutor({
    policy: () => ({ decision: "ask", grantKey: "write:a.txt" }),
  });
  const session = await Session.create({
    requestRecording: "off",
    runtime: new May({
      model,
      context: new InMemoryContext(),
      toolExecutor: permissions,
      tools: [
        {
          name: "write",
          description: "Write a file",
          inputSchema: { type: "object" },
          async execute() {
            return { bytes: 1 };
          },
        },
      ],
    }),
  });
  permissions.setEventSink((event) => session.recordPermissionEvent(event));

  const run = await session.submit({ input: "write" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const requested = (await iterator.next()).value;
  await permissions.resolve(requested.request.id, "allow-session");
  await run.result;

  const history = await session.history();
  assert.deepEqual(
    history.map((event) => event.type),
    [
      "session.created",
      "input.submitted",
      "run.started",
      "assistant.completed",
      "tool.started",
      "approval.requested",
      "approval.resolved",
      "tool.completed",
      "assistant.completed",
      "run.completed",
      "run.settled",
    ],
  );
  const approval = history.find((event) => event.type === "approval.requested");
  assert.equal(approval.request.runId, run.id);
  assert.equal(approval.request.toolCallId, "call_write");
  assert.equal(approval.request.grantKey, "write:a.txt");
  assert.equal("signal" in approval.request, false);
  assert.equal(history.find((event) => event.type === "approval.resolved").decision, "allow-session");
  await permissions.close();
});

test("records approval cancellation before run cancellation", async () => {
  const store = new InMemorySessionStore();
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [],
          toolCalls: [{ id: "call_bash", name: "bash", input: { command: "pwd" } }],
        },
      };
    },
  };
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const session = await Session.create({
    requestRecording: "off",
    store,
    runtime: new May({
      model,
      context: new InMemoryContext(),
      toolExecutor: permissions,
      tools: [
        {
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
          async execute() {
            return "unreachable";
          },
        },
      ],
    }),
  });
  permissions.setEventSink((event) => session.recordPermissionEvent(event));

  const run = await session.submit({ input: "run" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  await iterator.next();
  const rejected = assert.rejects(run.result, RunCancelledError);
  run.cancel("user stopped");
  await rejected;

  const history = await session.history();
  assert.deepEqual(
    history.slice(-3).map((event) => event.type),
    ["approval.requested", "approval.cancelled", "run.cancelled"],
  );
  const request = history.find((event) => event.type === "approval.requested");
  assert.equal("grantKey" in request.request, false);
  assert.equal(history.find((event) => event.type === "approval.cancelled").reason, "user stopped");
  let replayed;
  await Session.resume({
    requestRecording: "off",
    id: session.id,
    store,
    createRuntime(messages) {
      replayed = messages;
      return createRuntime();
    },
  });
  assert.deepEqual(
    replayed.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(replayed[2].toolCallId, "call_bash");
  assert.equal(replayed[2].isError, true);
  assert.equal(replayed[2].content[0].value.code, "RUN_CANCELLED");
  assert.equal(replayed[2].content[0].value.message, "user stopped");
  await permissions.close();
});

test("records failures and starts the next queued submission", async () => {
  let attempt = 0;
  const model = {
    async *stream() {
      attempt += 1;
      if (attempt === 1) throw new Error("model unavailable");
      yield {
        type: "response.completed",
        message: assistantMessage("recovered"),
      };
    },
  };
  const session = await Session.create({
    requestRecording: "off",
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const first = await session.submit({ input: "fail" });
  const secondSubmission = session.submit({ input: "retry" });

  await assert.rejects(first.result, /model unavailable/);
  const second = await secondSubmission;
  assert.equal((await second.result).message.content[0].text, "recovered");
  assert.ok((await session.history()).some((event) => event.type === "run.failed"));
});

test("continues a failed run without recording another user input", async () => {
  let modelCalls = 0;
  let continuedRequest;
  const runtime = new May({
    context: new InMemoryContext(),
    model: {
      async *stream(request) {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error("temporary failure");
        continuedRequest = request;
        yield {
          type: "response.completed",
          message: assistantMessage("recovered"),
        };
      },
    },
  });
  const session = await Session.create({ requestRecording: "off", runtime });

  await assert.rejects((await session.submit({ input: "original input" })).result, /temporary failure/);
  const retried = await session.continue();
  await retried.result;

  assert.equal(modelCalls, 2);
  assert.deepEqual(
    continuedRequest.messages.map((message) => message.role),
    ["user"],
  );
  const history = await session.history();
  assert.equal(history.filter((event) => event.type === "input.submitted").length, 1);
  assert.deepEqual(
    history.filter((event) => event.type === "run.started").map((event) => event.continuation === true),
    [false, true],
  );
  assert.equal(history.at(-1).type, "run.settled");
});

test("preserves cancellation and records its reason", async () => {
  const modelStarted = deferred();
  const model = {
    async *stream(_request, { signal }) {
      modelStarted.resolve();
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      yield {
        type: "response.completed",
        message: assistantMessage("unreachable"),
      };
    },
  };
  const session = await Session.create({
    requestRecording: "off",
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const run = await session.submit({ input: "wait" });
  await modelStarted.promise;
  run.cancel("user stopped");

  await assert.rejects(run.result, RunCancelledError);
  const cancelled = (await session.history()).find((event) => event.type === "run.cancelled");
  assert.equal(cancelled.reason, "user stopped");
});

test("does not persist input from a submission that was already cancelled", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    requestRecording: "off",
    id: "pre_cancelled",
    runtime: createRuntime(),
    store,
  });
  const controller = new AbortController();
  controller.abort("never submit");

  const run = await session.submit({ input: "ghost", signal: controller.signal });
  await assert.rejects(run.result, RunCancelledError);
  assert.equal(
    (await session.history()).some((event) => event.type === "input.submitted"),
    false,
  );

  let replayed;
  await Session.resume({
    requestRecording: "off",
    id: session.id,
    store,
    createRuntime(messages) {
      replayed = messages;
      return createRuntime();
    },
  });
  assert.deepEqual(replayed, []);
});

test("keeps durable and live input aligned when cancellation races storage", async () => {
  const backing = new InMemorySessionStore();
  const inputStarted = deferred();
  const releaseInput = deferred();
  const store = {
    read: (sessionId) => backing.read(sessionId),
    async append(event) {
      if (event.type === "input.submitted") {
        inputStarted.resolve();
        await releaseInput.promise;
      }
      await backing.append(event);
    },
  };
  const context = new InMemoryContext();
  const session = await Session.create({
    requestRecording: "off",
    runtime: new May({
      context,
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            message: assistantMessage("unreachable"),
          };
        },
      },
    }),
    store,
  });
  const controller = new AbortController();
  const submission = session.submit({
    input: "committed before cancellation",
    signal: controller.signal,
  });

  await inputStarted.promise;
  controller.abort("cancel during storage");
  releaseInput.resolve();
  const run = await submission;
  await assert.rejects(run.result, RunCancelledError);

  assert.equal((await session.history()).filter((event) => event.type === "input.submitted").length, 1);
  assert.deepEqual((await context.snapshot()).messages, [
    {
      role: "user",
      content: [{ type: "text", text: "committed before cancellation" }],
    },
  ]);
});

function collect(events) {
  return (async () => {
    const collected = [];
    for await (const event of events) collected.push(event);
    return collected;
  })();
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
