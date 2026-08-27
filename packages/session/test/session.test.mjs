import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryContext,
  May,
  RunCancelledError,
} from "@may/core";
import {
  InMemorySessionStore,
  Session,
} from "../dist/index.js";

test("creates a session with durable identity and metadata", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    id: "session_test",
    metadata: { workspace: "/repo" },
    runtime: createRuntime(),
    store,
  });

  assert.equal(session.id, "session_test");
  assert.deepEqual(session.metadata, { workspace: "/repo" });
  const history = await session.history();
  assert.equal(typeof history[0].timestamp, "number");
  assert.deepEqual(history.map(({ timestamp: _timestamp, ...event }) => event), [
    {
      type: "session.created",
      sessionId: "session_test",
      seq: 1,
      metadata: { workspace: "/repo" },
    },
  ]);
});

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
    [
      "session.created",
      "input.submitted",
      "run.started",
      "assistant.completed",
      "run.completed",
    ],
  );

  const assistantEvent = (await session.history()).find(
    (event) => event.type === "assistant.completed",
  );
  assert.deepEqual(assistantEvent.usage, { totalTokens: 2 });
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
    runtime: new May({
      model,
      context: new InMemoryContext(),
      tools: [
        {
          name: "ok",
          description: "Succeeds",
          inputSchema: { type: "object" },
          async execute() {
            return { value: 1 };
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
  const toolEvents = (await session.history()).filter(
    (event) => event.type === "tool.completed" || event.type === "tool.failed",
  );

  assert.equal(toolEvents[0].type, "tool.completed");
  assert.deepEqual(toolEvents[0].output, { value: 1 });
  assert.equal(toolEvents[1].type, "tool.failed");
  assert.equal(toolEvents[1].error.message, "tool failed");
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
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const first = await session.submit({ input: "fail" });
  const secondSubmission = session.submit({ input: "retry" });

  await assert.rejects(first.result, /model unavailable/);
  const second = await secondSubmission;
  assert.equal((await second.result).message.content[0].text, "recovered");
  assert.ok(
    (await session.history()).some((event) => event.type === "run.failed"),
  );
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
    runtime: new May({ model, context: new InMemoryContext() }),
  });

  const run = await session.submit({ input: "wait" });
  await modelStarted.promise;
  run.cancel("user stopped");

  await assert.rejects(run.result, RunCancelledError);
  const cancelled = (await session.history()).find(
    (event) => event.type === "run.cancelled",
  );
  assert.equal(cancelled.reason, "user stopped");
});

test("rejects a duplicate session id in the same store", async () => {
  const store = new InMemorySessionStore();
  await Session.create({ id: "same", runtime: createRuntime(), store });

  await assert.rejects(
    Session.create({ id: "same", runtime: createRuntime(), store }),
    /already exists/,
  );
});

test("rejects out-of-order events in the in-memory store", async () => {
  const store = new InMemorySessionStore();

  await assert.rejects(
    store.append({
      type: "session.created",
      sessionId: "out_of_order",
      seq: 2,
      timestamp: Date.now(),
    }),
    /Expected session event sequence 1, received 2/,
  );
});

test("fails the session run when durable event storage fails", async () => {
  const backing = new InMemorySessionStore();
  const store = {
    read: (sessionId) => backing.read(sessionId),
    append(event) {
      if (event.type === "run.started") {
        return Promise.reject(new Error("store unavailable"));
      }
      return backing.append(event);
    },
  };
  const session = await Session.create({ runtime: createRuntime(), store });

  const run = await session.submit({ input: "hello" });

  await assert.rejects(run.result, /store unavailable/);
});

function createRuntime() {
  return new May({
    context: new InMemoryContext(),
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistantMessage("ok"),
        };
      },
    },
  });
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

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
