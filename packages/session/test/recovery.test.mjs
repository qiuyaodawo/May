import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, appendFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../dist/file-store.js";
import { May, InMemoryContext } from "@may/core";
import { Session, InMemorySessionStore } from "../dist/index.js";

const call = (id) => ({ id, name: "write", input: { id } });
const assistant = (toolCalls) => ({ role: "assistant", content: [], toolCalls });

test("file recovery removes only an incomplete final record and permits the next append", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "may-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileSessionStore(dir);
  await store.append({ type: "session.created", sessionId: "s", seq: 1, timestamp: 0 });
  const [file] = await readdir(dir);
  await appendFile(join(dir, file), '{"type":"run.sta');
  assert.equal((await store.read("s")).length, 1);
  await store.append({ type: "run.started", runId: "r", sessionId: "s", seq: 2, timestamp: 1 });
  assert.equal((await store.read("s")).length, 2);
  await appendFile(join(dir, file), "corrupt\n");
  await assert.rejects(store.read("s"), /Invalid session event JSON/);
});

test("history polling serializes with large appends and rejects malformed complete payloads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "may-poll-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileSessionStore(dir);
  await store.append({ type: "session.created", sessionId: "s", seq: 1, timestamp: 0 });
  const work = [];
  for (let seq = 2; seq <= 12; seq++) {
    work.push(store.read("s"));
    work.push(store.append({ type: "state.updated", key: "data", value: "x".repeat(256 * 1024), sessionId: "s", seq, timestamp: seq }));
  }
  await Promise.all(work);
  assert.equal((await store.read("s")).length, 12);
  const [file] = await readdir(dir);
  await appendFile(join(dir, file), JSON.stringify({ type: "assistant.completed", runId: "r", step: 1, message: null, sessionId: "s", seq: 13, timestamp: 13 }) + "\n");
  await assert.rejects(store.read("s"), /Invalid session event/);
});

test("recovery distinguishes unknown effects from unstarted calls, blocks execution, and persists findings", async () => {
  const store = new InMemorySessionStore();
  const facts = [
    { type: "session.created" },
    { type: "run.started", runId: "r", checkpointVersion: 1 },
    { type: "assistant.completed", runId: "r", step: 1, message: assistant([call("b"), call("a"), call("c")]) },
    { type: "tool.started", runId: "r", step: 1, call: call("a") },
    { type: "tool.completed", runId: "r", step: 1, call: call("a"), output: "done" },
    { type: "tool.started", runId: "r", step: 1, call: call("b") },
  ];
  for (const [index, fact] of facts.entries()) await store.append({ ...fact, sessionId: "s", seq: index + 1, timestamp: index });
  let seen; let calls = 0;
  const createRuntime = (messages) => new May({ context: new InMemoryContext({ messages }), model: {
    async *stream(request) { calls++; seen = request.messages; yield { type: "response.completed", message: { role: "assistant", content: [] } }; },
  }});
  const session = await Session.resume({ id: "s", store, createRuntime });
  assert.equal(session.listRecoveries().length, 1);
  assert.equal(session.listRecoveries()[0].call.id, "b");
  await assert.rejects(session.submit({ input: "continue" }), { code: "SESSION_RECOVERY_REQUIRED" });
  assert.equal(calls, 0);
  const repair = (await session.history()).at(-1);
  assert.deepEqual(repair.recoveries.map((r) => r.status), ["unknown", "not-started"]);
  const reopened = await Session.resume({ id: "s", store, createRuntime });
  assert.equal((await reopened.history()).length, facts.length + 1);
  await reopened.resolveRecovery("r:1:b", "Checked the destination: write completed successfully; do not repeat it.");
  await (await reopened.continue()).result;
  assert.equal(seen.filter((m) => m.role === "tool").length, 3);
  assert.deepEqual(seen.filter((m) => m.role === "tool").map((m) => m.toolCallId), ["b", "a", "c"]);
  assert.match(seen.at(-1).content[0].text, /Checked the destination/);
  const again = await Session.resume({ id: "s", store, createRuntime });
  assert.equal(again.listRecoveries().length, 0);
});

test("old histories conservatively treat unfinished calls as unknown", async () => {
  const store = new InMemorySessionStore();
  for (const [index, fact] of [
    { type: "session.created" }, { type: "run.started", runId: "r" },
    { type: "assistant.completed", runId: "r", step: 1, message: assistant([call("a")]) },
  ].entries()) await store.append({ ...fact, sessionId: "s", seq: index + 1, timestamp: index });
  const session = await Session.resume({ id: "s", store, createRuntime: (messages) => new May({ context: new InMemoryContext({ messages }), model: { async *stream() {} } }) });
  assert.equal(session.listRecoveries()[0].status, "unknown");
});

test("tools cannot run ahead of durable model/start/outcome checkpoints", async () => {
  const backing = new InMemorySessionStore(); let executed = 0;
  const store = { read: (id) => backing.read(id), append: async (event) => {
    if (event.type === "tool.completed") throw new Error("disk unavailable");
    await backing.append(event);
  }};
  const runtime = new May({ context: new InMemoryContext(), model: { async *stream() {
    yield { type: "response.completed", message: assistant([call("a"), call("b")]) };
  }}, tools: [{ name: "write", description: "write", inputSchema: {}, async execute() {
    const history = await backing.read("s");
    assert.equal(history.at(-1).type, "tool.started");
    assert.ok(history.some((e) => e.type === "assistant.completed"));
    executed++; return "done";
  }}] });
  const session = await Session.create({ id: "s", store, runtime });
  await assert.rejects((await session.submit({ input: "write" })).result, /disk unavailable/);
  assert.equal(executed, 1);
  const resumed = await Session.resume({ id: "s", store, createRuntime: () => runtime });
  assert.equal(resumed.listRecoveries()[0].call.id, "a");
});
