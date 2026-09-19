import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionStore, SessionHistoryReader } from "@may/session";
import { createSessionHistoryRetrievalTools, createSessionHistoryTool } from "../dist/index.js";

test("history tools expose saved model content and withhold raw and legacy tool output", async () => {
  const store = new InMemorySessionStore();
  const reader = new SessionHistoryReader(store);
  await store.append({ sessionId: "s", seq: 1, timestamp: 0, type: "session.created" });
  for (const [index, content] of [[{ type: "text", text: "public-result-marker" }], [], undefined].entries()) {
    await store.append({ sessionId: "s", seq: index + 2, timestamp: index, type: "tool.completed",
      runId: "run", step: 1, call: { id: String(index), name: "read", input: {} },
      output: { content: "raw-result-marker", _meta: { secret: "host-only-marker" } },
      ...(content === undefined ? {} : { content }),
    });
  }
  const source = { queryHistory: (query) => reader.query("s", query) };
  const context = { signal: new AbortController().signal };
  const history = createSessionHistoryTool({ source });
  const [search, read] = createSessionHistoryRetrievalTools({ source: () => source });
  const page = await history.execute(history.parse({ types: ["tool.completed"] }), context);
  assert.doesNotMatch(JSON.stringify(page), /host-only-marker|raw-result-marker/);
  assert.deepEqual(page.events[0].event.content, [{ type: "text", text: "public-result-marker" }]);
  assert.deepEqual(page.events[1].event.content, []);
  assert.match(page.events[2].event.content[0].text, /no saved model-visible content/);
  assert.equal((await search.execute(search.parse({ query: "host-only-marker" }), context)).matches.length, 0);
  assert.equal((await search.execute(search.parse({ query: "public-result-marker" }), context)).matches[0].seq, 2);
  for (const seq of [2, 3, 4]) {
    const record = await read.execute(read.parse({ seq }), context);
    assert.doesNotMatch(record.text, /host-only-marker|raw-result-marker/);
    assert.equal(Object.hasOwn(JSON.parse(record.text), "output"), false);
  }
  assert.match(JSON.stringify(await store.read("s")), /host-only-marker/);
});

test("searches beyond previews and reconstructs large Unicode records without truncation", async () => {
  const store = new InMemorySessionStore();
  const reader = new SessionHistoryReader(store);
  await store.append({ sessionId: "s", seq: 1, timestamp: 0, type: "session.created" });
  const event = { sessionId: "s", seq: 2, timestamp: 0, type: "input.submitted",
    message: { role: "user", content: [{ type: "text", text: "😀".repeat(6000) + "THE-NEEDLE" }] } };
  await store.append(event);
  const tools = createSessionHistoryRetrievalTools({ source: () => ({ queryHistory: (query) => reader.query("s", query) }) });
  const context = { signal: new AbortController().signal };
  const [search, read] = tools;
  const results = await search.execute(search.parse({ query: "the-needle" }), context);
  assert.equal(results.matches[0].seq, 2);
  let text = "", offset = 0;
  do {
    const chunk = await read.execute(read.parse({ seq: 2, offset, length: 257 }), context);
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 32768);
    text += chunk.text;
    if (!chunk.hasMore) break;
    assert.ok(chunk.nextOffset > offset);
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(text, JSON.stringify(event));
  assert.throws(() => read.parse({ seq: 2, length: 5000 }));
  await assert.rejects(read.execute(read.parse({ seq: 3 }), context), /not found/);
  await assert.rejects(search.execute(search.parse({ query: "x" }), { signal: AbortSignal.abort() }));
});

test("search is bounded and paginates without losing matches; replacement views stay omitted", async () => {
  const store = new InMemorySessionStore();
  const reader = new SessionHistoryReader(store);
  await store.append({ sessionId: "s", seq: 1, timestamp: 0, type: "session.created" });
  for (let seq = 2; seq < 24; seq++) await store.append({ sessionId: "s", seq, timestamp: 0,
    type: "input.submitted", message: { role: "user", content: [{ type: "text", text: "match\u0000".repeat(1000) }] } });
  await store.append({ sessionId: "s", seq: 24, timestamp: 0, type: "context.compacted", strategy: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hidden-replacement" }] }],
    beforeMessageCount: 22, afterMessageCount: 1, beforeEstimatedTokens: 2000, afterEstimatedTokens: 10 });
  const [search, read] = createSessionHistoryRetrievalTools({ source: () => ({ queryHistory: (query) => reader.query("s", query) }) });
  const context = { signal: new AbortController().signal };
  const seqs = [];
  let afterSeq;
  do {
    const result = await search.execute(search.parse({ query: "match", ...(afterSeq ? { afterSeq } : {}) }), context);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768);
    seqs.push(...result.matches.map((match) => match.seq));
    if (!result.hasMore) break;
    afterSeq = result.nextSeq;
  } while (true);
  assert.deepEqual(seqs, Array.from({ length: 22 }, (_, index) => index + 2));
  const result = await read.execute(read.parse({ seq: 24 }), context);
  assert.doesNotMatch(result.text, /hidden-replacement/);
  assert.match(result.text, /replacementMessageCount/);
});
