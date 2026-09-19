import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { FileSessionStore } from "../dist/file-store.js";
import { Session } from "../dist/index.js";

test("file history restores saved multimodal content and withholds legacy raw output", async (t) => {
  const review = new URL("../../../review/", import.meta.url);
  await mkdir(review, { recursive: true });
  const directory = await mkdtemp(new URL("session-content-", review));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileSessionStore(directory);
  const content = [
    { type: "text", text: "Public result" },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG7sAAAAASUVORK5CYII=" } },
    { type: "json", value: { count: 1 } },
  ];
  const calls = ["projected", "empty", "legacy"].map((id) => ({ id, name: "read", input: {} }));
  const payloads = [
    { type: "session.created" },
    { type: "run.started", runId: "run", checkpointVersion: 1 },
    { type: "assistant.completed", runId: "run", step: 1, message: { role: "assistant", content: [], toolCalls: calls } },
    ...calls.map((call, index) => ({ type: "tool.completed", runId: "run", step: 1, call,
      output: { _meta: { secret: "host-only-marker" } },
      ...(index === 2 ? {} : { content: index === 1 ? [] : content }),
    })),
    { type: "run.cancelled", runId: "run" },
  ];
  for (const [index, payload] of payloads.entries()) {
    await store.append({ ...payload, sessionId: "session", seq: index + 1, timestamp: index });
  }
  const reopened = new FileSessionStore(directory);
  assert.match(JSON.stringify(await reopened.read("session")), /host-only-marker/);
  const inspected = new Error("恢复内容检查完成");
  await assert.rejects(Session.resume({ id: "session", store: reopened, createRuntime(messages) {
    const results = messages.filter((message) => message.role === "tool");
    assert.deepEqual(results[0].content, content);
    assert.deepEqual(results[1].content, []);
    assert.match(results[2].content[0].text, /no saved model-visible content/);
    assert.doesNotMatch(JSON.stringify(messages), /host-only-marker/);
    throw inspected;
  } }), (error) => error === inspected);
  await store.append({ type: "tool.completed", sessionId: "invalid", runId: "run", step: 1,
    seq: 1, timestamp: 0, call: calls[0], output: {}, content: [{ type: "text", text: 7 }],
  });
  await assert.rejects(new FileSessionStore(directory).read("invalid"), /Invalid session event/);
});
