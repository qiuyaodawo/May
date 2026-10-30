import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requestReferences, requestValueId, readRecordedModelRequests, validateSessionHistory } from "@sortedyuan/may/session";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { executeRecordedOperation } from "@sortedyuan/may/core";

test("真实文件保存内容引用、尝试状态并拒绝损坏的历史", async () => {
  const root = resolve(".test-output/request-recording");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/history-`);
  try {
    const definitions = new Map();
    const define = value => { const id = requestValueId(value); definitions.set(id, value); return id; };
    const request = requestReferences({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [] }, define);
    const body = requestReferences({ model: "example", messages: [{ role: "user", content: "hello" }] }, define);
    const payloads = [{ type: "session.created" }, ...[...definitions].map(([id, value]) => ({ type: "model.request.defined", id, value })),
      { type: "model.request.prepared", version: 1, modelCallId: "run:model:1", runId: "run", step: 1, attempt: 1, adapter: "example", purpose: "generation", request, body },
      { type: "model.attempt.started", modelCallId: "run:model:1", runId: "run", step: 1, attempt: 1 },
      { type: "model.attempt.failed", modelCallId: "run:model:1", runId: "run", step: 1, attempt: 1, cancelled: true, errorName: "AbortError", durationMs: 1 }];
    const events = payloads.map((payload, index) => ({ ...payload, sessionId: "history", seq: index + 1, timestamp: Date.now() }));
    const store = new FileSessionStore(directory);
    await store.appendBatch(events);
    const saved = await store.read("history");
    const [recorded] = readRecordedModelRequests(saved);
    assert.equal(recorded.status, "cancelled");
    assert.equal(recorded.record.body.model, "example");
    assert.equal(recorded.record.request.messages[0].content[0].text, "hello");
    const prepared = saved.find(event => event.type === "model.request.prepared");
    assert.equal(readRecordedModelRequests(saved.slice(0, prepared.seq))[0].status, "prepared");
    assert.equal(readRecordedModelRequests(saved.slice(0, -1))[0].status, "unknown");
    const broken = structuredClone(saved);
    broken.find(event => event.type === "model.request.defined").value = "corrupted";
    assert.throws(() => validateSessionHistory("history", broken), /digest/);
    assert.throws(() => readRecordedModelRequests(saved.filter(event => event.type !== "model.request.defined")), /Missing request definition/);
    assert.equal(requestValueId({ b: 2, a: 1 }), requestValueId({ a: 1, b: 2 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("请求准备记录省略 URL 凭据，执行保留原始内容，文件记录失败时停止执行", async () => {
  const root = resolve(".test-output/request-recording");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/operation-`);
  try {
    const log = resolve(directory, "events.jsonl");
    const output = resolve(directory, "body.json");
    const url = "https://user:password@example.com/image?signature=secret";
    const record = { version: 1, adapter: "operation", purpose: "generation", request: { messages: [], tools: [] }, body: { image_url: url } };
    const signal = new AbortController().signal;
    await executeRecordedOperation(record, event => appendFile(log, `${JSON.stringify(event)}\n`), signal, body => writeFile(output, body));
    const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ["prepared", "started", "completed"]);
    assert.equal(events[0].record.body.image_url, "https://example.com/image");
    assert.deepEqual(events[0].record.omittedPaths, ["/body/image_url"]);
    assert.deepEqual(events[0].record.externalResourcePaths, ["/body/image_url"]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).image_url, url);
    await rm(output);
    await assert.rejects(executeRecordedOperation(record, event => writeFile(directory, JSON.stringify(event)), signal, body => writeFile(output, body)));
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
