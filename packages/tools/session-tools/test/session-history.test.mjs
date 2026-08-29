import assert from "node:assert/strict";
import test from "node:test";

import { createSessionHistoryTool } from "../dist/index.js";

test("queries bounded session history and omits compacted replacement messages", async () => {
  let query;
  const source = {
    async queryHistory(value) {
      query = value;
      return {
        events: [
          event(4, {
            type: "context.compacted",
            strategy: "summary-tail",
            messages: [user("large hidden replacement")],
            beforeMessageCount: 10,
            afterMessageCount: 3,
            beforeEstimatedTokens: 1000,
            afterEstimatedTokens: 200,
          }),
        ],
        hasMore: false,
      };
    },
  };
  const tool = createSessionHistoryTool({ source, maxEvents: 10 });
  const input = tool.parse({
    afterSeq: 2,
    order: "asc",
    types: ["context.compacted"],
  });
  const output = await tool.execute(input, context());

  assert.deepEqual(query, {
    afterSeq: 2,
    order: "asc",
    types: ["context.compacted"],
    limit: 10,
  });
  assert.equal(output.events.length, 1);
  assert.equal("messages" in output.events[0].event, false);
  assert.equal(output.events[0].event.replacementMessageCount, 1);
  assert.equal(output.outputTruncated, false);
});

test("bounds individual events and total tool output", async () => {
  const source = {
    async queryHistory() {
      return {
        events: [
          event(1, {
            type: "input.submitted",
            message: user("x".repeat(2000)),
          }),
          event(2, {
            type: "assistant.completed",
            runId: "run",
            step: 1,
            message: assistant("y".repeat(2000)),
          }),
        ],
        hasMore: false,
      };
    },
  };
  const tool = createSessionHistoryTool({
    source,
    maxEvents: 10,
    maxEventBytes: 180,
    maxOutputBytes: 350,
  });
  const output = await tool.execute(tool.parse({}), context());

  assert.equal(output.events[0].truncated, true);
  assert.match(output.events[0].preview, /\[truncated\]$/u);
  assert.equal(output.outputTruncated, true);
  assert.equal(output.hasMore, true);
  assert.equal(output.nextSeq, output.events.at(-1).seq);
  assert.ok(new TextEncoder().encode(JSON.stringify(output)).byteLength < 500);
});

test("validates tool input and cancellation", async () => {
  const tool = createSessionHistoryTool({
    source: { queryHistory: async () => ({ events: [], hasMore: false }) },
    maxEvents: 2,
  });
  assert.throws(() => tool.parse({ limit: 3 }), /cannot exceed 2/u);
  assert.throws(() => tool.parse({ types: ["unknown"] }), /unknown event type/u);
  assert.throws(() => tool.parse({ extra: true }), /unknown field/u);

  const controller = new AbortController();
  controller.abort("stop history");
  await assert.rejects(
    tool.execute({}, context(controller.signal)),
    { name: "AbortError", message: "stop history" },
  );
});

function event(seq, payload) {
  return {
    ...payload,
    sessionId: "session",
    seq,
    timestamp: seq,
  };
}

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function context(signal = new AbortController().signal) {
  return {
    runId: "run",
    step: 1,
    toolCallId: "call",
    idempotencyKey: "run:call",
    signal,
  };
}
