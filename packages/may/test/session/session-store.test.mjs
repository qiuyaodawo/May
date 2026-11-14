import assert from "node:assert/strict";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestDirectory } from "@sortedyuan/test-support";
import { InMemoryContext, May } from "@sortedyuan/may/core";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { InMemorySessionStore, Session } from "@sortedyuan/may/session";

import { assistantMessage, createRuntime } from "./fixtures/runtime.mjs";

test("rejects a duplicate session id in the same store", async () => {
  const store = new InMemorySessionStore();
  await Session.create({ requestRecording: "off", id: "same", runtime: createRuntime(), store });

  await assert.rejects(
    Session.create({ requestRecording: "off", id: "same", runtime: createRuntime(), store }),
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

test("queues file-session deletion with appends for the same session", async (t) => {
  const directory = await createTestDirectory(t, "may/session");
  const store = new FileSessionStore(directory);
  const sessionId = "delete_queue";
  await store.append({
    type: "session.created",
    sessionId,
    seq: 1,
    timestamp: 1,
  });

  const append = store.append({
    type: "run.started",
    sessionId,
    seq: 2,
    timestamp: 2,
    runId: "run",
  });
  const deletion = store.delete(sessionId);

  await append;
  assert.equal(await deletion, true);
  assert.deepEqual(await store.read(sessionId), []);
});

test("resumes a file session and continues its context and sequence", async (t) => {
  const directory = await createTestDirectory(t, "may/session");
  const firstStore = new FileSessionStore(directory);
  const first = await Session.create({
    requestRecording: "off",
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
  await (
    await first.submit({ input: "first question" })
  ).result;

  let restoredMessages;
  let secondRequest;
  const secondStore = new FileSessionStore(directory);
  const resumed = await Session.resume({
    requestRecording: "off",
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
  assert.deepEqual(
    restoredMessages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(restoredMessages[1].modelState, {
    type: "test/v1",
    data: { cursor: "abc" },
  });

  await (
    await resumed.submit({ input: "second question" })
  ).result;
  assert.deepEqual(
    secondRequest.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );

  const history = await resumed.history();
  assert.deepEqual(
    history.map((event) => event.seq),
    history.map((_event, index) => index + 1),
  );
  assert.equal(history.filter((event) => event.type === "session.created").length, 1);
});

test("restores the latest model input measurement when resuming", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    requestRecording: "off",
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
  await (
    await session.submit({ input: "measure me" })
  ).result;

  let runtimeInfo;
  await Session.resume({
    requestRecording: "off",
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
    runtime: { id: "may", version: "1" },
  });
});

test("replays the latest compacted context without deleting history", async () => {
  const store = new InMemorySessionStore();
  const session = await Session.create({
    requestRecording: "off",
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
  await (
    await session.submit({ input: "original question" })
  ).result;
  const compactedMessages = [{ role: "user", content: [{ type: "text", text: "compact view" }] }];
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
    requestRecording: "off",
    id: session.id,
    store,
    createRuntime(messages, info) {
      replayed = messages;
      runtimeInfo = info;
      return createRuntime();
    },
  });

  assert.deepEqual(replayed, compactedMessages);
  assert.deepEqual(runtimeInfo, { runtime: { id: "may", version: "1" } });
  const history = await session.history();
  assert.ok(history.some((event) => event.type === "input.submitted"));
  assert.ok(history.some((event) => event.type === "assistant.completed"));
  assert.deepEqual(
    history.find((event) => event.type === "context.compacted"),
    {
      type: "context.compacted",
      sessionId: "compacted",
      seq: 7,
      timestamp: history[6].timestamp,
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
  const directory = await createTestDirectory(t, "may/session");
  const store = new FileSessionStore(directory);

  await assert.rejects(
    Session.resume({
      requestRecording: "off",
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

test("requires reopen after a durable append fails and preserves the sequence", async () => {
  const backing = new InMemorySessionStore();
  let failed = false;
  const store = {
    read: (sessionId) => backing.read(sessionId),
    append(event) {
      if (event.type === "run.started" && !failed) {
        failed = true;
        return Promise.reject(new Error("store unavailable"));
      }
      return backing.append(event);
    },
  };
  const session = await Session.create({ requestRecording: "off", runtime: createRuntime(), store });

  const run = await session.submit({ input: "hello" });

  await assert.rejects(run.result, /store unavailable/);
  await assert.rejects(session.submit({ input: "retry" }), /reopen/);
  const resumed = await Session.resume({ requestRecording: "off", id: session.id, store, createRuntime });
  await (
    await resumed.submit({ input: "retry" })
  ).result;
  const history = await resumed.history();
  assert.deepEqual(
    history.map((event) => event.seq),
    history.map((_event, index) => index + 1),
  );
});
