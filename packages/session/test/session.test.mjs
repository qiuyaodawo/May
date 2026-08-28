import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryContext,
  May,
  RunCancelledError,
} from "@may/core";
import { PermissionToolExecutor } from "@may/permissions";
import { FileSessionStore } from "@may/session/file-store";
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
  const store = new InMemorySessionStore();
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

  let replayed;
  await Session.resume({
    id: session.id,
    store,
    createRuntime(messages) {
      replayed = messages;
      return createRuntime();
    },
  });
  assert.deepEqual(replayed.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant",
  ]);
  assert.deepEqual(replayed[2].content[0].value, { value: 1 });
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
            toolCalls: [
              { id: "call_write", name: "write", input: { path: "a.txt" } },
            ],
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
      "approval.requested",
      "approval.resolved",
      "tool.completed",
      "assistant.completed",
      "run.completed",
    ],
  );
  const approval = history.find((event) => event.type === "approval.requested");
  assert.equal(approval.request.runId, run.id);
  assert.equal(approval.request.toolCallId, "call_write");
  assert.equal(approval.request.grantKey, "write:a.txt");
  assert.equal("signal" in approval.request, false);
  assert.equal(
    history.find((event) => event.type === "approval.resolved").decision,
    "allow-session",
  );
  await permissions.close();
});

test("records approval cancellation before run cancellation", async () => {
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [],
          toolCalls: [
            { id: "call_bash", name: "bash", input: { command: "pwd" } },
          ],
        },
      };
    },
  };
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const session = await Session.create({
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
  assert.equal(
    history.find((event) => event.type === "approval.cancelled").reason,
    "user stopped",
  );
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

test("persists session events across file store instances", async (t) => {
  const directory = await createTempDirectory(t);
  const sessionId = "session/with:unsafe*characters";
  const first = new FileSessionStore(directory);

  await first.append({
    type: "session.created",
    sessionId,
    seq: 1,
    timestamp: 1,
  });
  await first.append({
    type: "input.submitted",
    sessionId,
    seq: 2,
    timestamp: 2,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });

  const second = new FileSessionStore(directory);
  const history = await second.read(sessionId);
  assert.deepEqual(history.map((event) => event.seq), [1, 2]);
  assert.equal(history[1].message.content[0].text, "hello");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[A-Za-z0-9_-]+\.jsonl$/u);
});

test("resumes a file session and continues its context and sequence", async (t) => {
  const directory = await createTempDirectory(t);
  const firstStore = new FileSessionStore(directory);
  const first = await Session.create({
    id: "resume_me",
    metadata: { workspace: "/repo" },
    store: firstStore,
    runtime: new May({
      context: new InMemoryContext(),
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            message: {
              ...assistantMessage("first answer"),
              modelState: { type: "test/v1", data: { cursor: "abc" } },
            },
          };
        },
      },
    }),
  });
  await (await first.submit({ input: "first question" })).result;

  let restoredMessages;
  let secondRequest;
  const secondStore = new FileSessionStore(directory);
  const resumed = await Session.resume({
    id: "resume_me",
    store: secondStore,
    async createRuntime(messages) {
      await new Promise((resolve) => setImmediate(resolve));
      restoredMessages = messages;
      return new May({
        context: new InMemoryContext({ messages }),
        model: {
          async *stream(request) {
            secondRequest = request;
            yield {
              type: "response.completed",
              message: assistantMessage("second answer"),
            };
          },
        },
      });
    },
  });

  assert.deepEqual(resumed.metadata, { workspace: "/repo" });
  assert.deepEqual(restoredMessages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
  assert.deepEqual(restoredMessages[1].modelState, {
    type: "test/v1",
    data: { cursor: "abc" },
  });

  await (await resumed.submit({ input: "second question" })).result;
  assert.deepEqual(secondRequest.messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
  ]);

  const history = await resumed.history();
  assert.deepEqual(
    history.map((event) => event.seq),
    history.map((_event, index) => index + 1),
  );
  assert.equal(
    history.filter((event) => event.type === "session.created").length,
    1,
  );
});

test("restores the latest model input measurement when resuming", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    id: "measured",
    store,
    runtime: new May({
      context: new InMemoryContext(),
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            message: assistantMessage("measured answer"),
            usage: { inputTokens: 123, outputTokens: 4, totalTokens: 127 },
          };
        },
      },
    }),
  });
  await (await session.submit({ input: "measure me" })).result;

  let runtimeInfo;
  await Session.resume({
    id: session.id,
    store,
    createRuntime(_messages, info) {
      runtimeInfo = info;
      return createRuntime();
    },
  });

  assert.deepEqual(runtimeInfo, {
    latestModelMeasurement: {
      inputTokens: 123,
      contextMessageCount: 1,
    },
  });
});

test("replays the latest compacted context without deleting history", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    id: "compacted",
    store,
    runtime: new May({
      context: new InMemoryContext(),
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            message: assistantMessage("original answer"),
            usage: { inputTokens: 100 },
          };
        },
      },
    }),
  });
  await (await session.submit({ input: "original question" })).result;
  const compactedMessages = [
    { role: "user", content: [{ type: "text", text: "compact view" }] },
  ];
  await session.recordContextCompaction({
    strategy: "test",
    messages: compactedMessages,
    beforeMessageCount: 2,
    afterMessageCount: 1,
    beforeEstimatedTokens: 100,
    afterEstimatedTokens: 20,
  });

  let replayed;
  let runtimeInfo;
  await Session.resume({
    id: session.id,
    store,
    createRuntime(messages, info) {
      replayed = messages;
      runtimeInfo = info;
      return createRuntime();
    },
  });

  assert.deepEqual(replayed, compactedMessages);
  assert.deepEqual(runtimeInfo, {});
  const history = await session.history();
  assert.ok(history.some((event) => event.type === "input.submitted"));
  assert.ok(history.some((event) => event.type === "assistant.completed"));
  assert.deepEqual(
    history.find((event) => event.type === "context.compacted"),
    {
      type: "context.compacted",
      sessionId: "compacted",
      seq: 6,
      timestamp: history[5].timestamp,
      strategy: "test",
      messages: compactedMessages,
      beforeMessageCount: 2,
      afterMessageCount: 1,
      beforeEstimatedTokens: 100,
      afterEstimatedTokens: 20,
    },
  );
});

test("reports missing sessions and corrupt session files", async (t) => {
  const directory = await createTempDirectory(t);
  const store = new FileSessionStore(directory);

  await assert.rejects(
    Session.resume({
      id: "missing",
      store,
      createRuntime,
    }),
    /does not exist/,
  );

  await store.append({
    type: "session.created",
    sessionId: "corrupt",
    seq: 1,
    timestamp: 1,
  });
  const [file] = await readdir(directory);
  await appendFile(join(directory, file), "not-json\n", "utf8");

  await assert.rejects(store.read("corrupt"), /Invalid session event JSON/);
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

async function createTempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "may-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
