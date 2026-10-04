import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { InMemoryContext, May, userMessage } from "@may/core";
import { OpenAIResponsesModel } from "@may/provider-openai";
import { FileSessionStore } from "../dist/file-store.js";
import { Session, SessionHistoryReader } from "../dist/index.js";

async function createStore(t) {
  const review = new URL("../../../review/", import.meta.url);
  await mkdir(review, { recursive: true });
  const directory = await mkdtemp(new URL("session-generated-", review));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new FileSessionStore(directory);
}

function generatedInput(overrides = {}) {
  return {
    type: "input.generated",
    runId: "continuation",
    step: 1,
    messages: [userMessage("Continue the current request")],
    reason: "Host continuation",
    ...overrides,
  };
}

async function appendPayloads(store, sessionId, payloads) {
  for (const [index, payload] of payloads.entries()) {
    await store.append({ ...payload, sessionId, seq: index + 1, timestamp: index });
  }
}

function createRuntime(messages) {
  return new May({
    context: new InMemoryContext({ messages }),
    model: new OpenAIResponsesModel({ apiKey: "local-session-storage-check", model: "local-session-storage-check" }),
  });
}

test("FileSessionStore 重新打开后读取并恢复 generated input", async (t) => {
  const store = await createStore(t);
  const messages = [userMessage("Continue the current request"), {
    role: "user",
    content: [{ type: "json", value: { status: "continue" } }],
  }];
  await appendPayloads(store, "continuation", [
    { type: "session.created" },
    generatedInput({ messages }),
  ]);

  const reopened = new FileSessionStore(store.directory);
  const history = await reopened.read("continuation");
  assert.deepEqual(history[1].messages, messages);
  assert.equal(history[1].reason, "Host continuation");
  assert.deepEqual(await reopened.inspect("continuation"), history);
  const page = await new SessionHistoryReader(reopened).query("continuation", {
    types: ["input.generated"],
  });
  assert.deepEqual(page.events, [history[1]]);

  const restored = await Session.resume({
    id: "continuation",
    store: reopened,
    createRuntime(restoredMessages) {
      assert.deepEqual(restoredMessages, messages);
      return createRuntime(restoredMessages);
    },
  });
  assert.deepEqual((await restored.getRuntimeInfo()).messages, messages);
  await restored.closeRuntime();

  await reopened.append({ type: "state.updated", key: "continuation", value: true,
    sessionId: "continuation", seq: 3, timestamp: 3 });
  assert.equal((await new FileSessionStore(store.directory).read("continuation")).length, 3);
});

test("Session.fork 保存已交付的补充输入并成功重新打开文件分支", async (t) => {
  const store = await createStore(t);
  const request = userMessage("Inspect the session history");
  const delivered = userMessage("Preserve this additional input");
  const response = { role: "assistant", content: [{ type: "text", text: "History inspected" }] };
  await appendPayloads(store, "source", [
    { type: "session.created" },
    { type: "input.submitted", message: request },
    { type: "run.started", runId: "source-run" },
    { type: "input.steering.queued", input: { inputId: "additional-input", message: delivered, status: "pending", runId: "source-run" } },
    { type: "input.steering.delivered", runId: "source-run", step: 1, inputIds: ["additional-input"] },
    { type: "assistant.completed", runId: "source-run", step: 1, message: response },
    { type: "run.completed", runId: "source-run", result: { runId: "source-run", steps: 1, modelCalls: 1, toolCalls: 0, message: response } },
    { type: "run.settled", runId: "source-run" },
  ]);
  const source = await store.inspect("source");
  const branch = await Session.fork({ sourceId: "source", positionSeq: 8, id: "branch", store, createRuntime });
  assert.deepEqual((await branch.getRuntimeInfo()).messages, [request, delivered, response]);
  await branch.closeRuntime();

  const reopened = new FileSessionStore(store.directory);
  const generated = (await reopened.read("branch")).find((event) => event.type === "input.generated");
  assert.equal(generated.reason, "Inherited delivered input");
  assert.deepEqual(generated.messages, [delivered]);
  assert.deepEqual(await reopened.inspect("branch"), await reopened.read("branch"));
  const restored = await Session.resume({ id: "branch", store: reopened, createRuntime });
  assert.deepEqual((await restored.getRuntimeInfo()).messages, [request, delivered, response]);
  await restored.closeRuntime();
  assert.deepEqual(await reopened.inspect("source"), source);
});

test("FileSessionStore 拒绝字段无效的 generated input 完整记录", async (t) => {
  const store = await createStore(t);
  const invalid = [
    { runId: undefined }, { runId: 7 }, { runId: " " },
    { step: undefined }, { step: 0 }, { step: 1.5 }, { step: Number.MAX_SAFE_INTEGER + 1 },
    { messages: undefined }, { messages: {} }, { messages: [null] },
    { messages: [{ role: "assistant", content: [] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: 7 }] }] },
    { reason: undefined }, { reason: 7 }, { reason: " " },
  ];
  for (const [index, overrides] of invalid.entries()) {
    const sessionId = `invalid-${index}`;
    await appendPayloads(store, sessionId, [
      { type: "session.created" }, generatedInput(overrides),
    ]);
    const reopened = new FileSessionStore(store.directory);
    await assert.rejects(reopened.read(sessionId), /Invalid session event/);
    await assert.rejects(reopened.inspect(sessionId), /Invalid session event/);
  }
});
