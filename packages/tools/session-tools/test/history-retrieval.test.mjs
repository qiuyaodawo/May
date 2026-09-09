import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionStore, SessionHistoryReader } from "@may/session";
import { createSessionHistoryRetrievalTools } from "../dist/index.js";

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
