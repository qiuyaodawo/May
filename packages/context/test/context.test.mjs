import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryContextFactory,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
} from "../dist/index.js";

test("creates independent in-memory contexts from factory input", async () => {
  const factory = new InMemoryContextFactory();
  const messages = [message("initial")];
  const first = await factory.create({
    instructions: "system",
    messages,
    metadata: { workspace: "one" },
  });
  const second = await factory.create({ messages });

  await first.context.append([message("added")]);

  assert.deepEqual(await first.context.snapshot(), {
    instructions: "system",
    messages: [message("initial"), message("added")],
    metadata: { workspace: "one" },
  });
  assert.deepEqual(await second.context.snapshot(), {
    messages: [message("initial")],
  });
  assert.deepEqual(messages, [message("initial")]);

  const inspection = await first.controller.inspect();
  const messageBytes = byteLength(message("initial")) + byteLength(message("added"));
  assert.deepEqual(inspection, {
    instructionsBytes: 6,
    messageBytes,
    totalBytes: 6 + messageBytes,
    messageCount: 2,
    messagesByRole: { system: 0, user: 2, assistant: 0, tool: 0 },
    toolResultCount: 0,
    estimatedTokens: Math.ceil((6 + messageBytes) / 4),
    tokenEstimateMethod: "utf8-bytes/4",
    effectiveTokens: Math.ceil((6 + messageBytes) / 4),
    measurementMethod: "estimated",
  });
});

test("combines measured input usage with an estimated context tail", async () => {
  const initial = message("initial");
  const tail = message("tail");
  const managed = new InMemoryContextFactory().create({
    messages: [initial, tail],
    budget: { contextWindowTokens: 1000, outputReserveTokens: 100 },
    measurement: { inputTokens: 120, contextMessageCount: 1 },
  });

  const inspection = await managed.controller.inspect();
  const estimatedTailTokens = Math.ceil(byteLength(tail) / 4);
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.measuredInputTokens, 120);
  assert.equal(inspection.estimatedTailTokens, estimatedTailTokens);
  assert.equal(inspection.effectiveTokens, 120 + estimatedTailTokens);
  assert.equal(inspection.contextWindowTokens, 1000);
  assert.equal(inspection.remainingTokens, 1000 - inspection.effectiveTokens);
  assert.equal(inspection.usageRatio, inspection.effectiveTokens / 1000);
});

test("updates the measurement from model usage", async () => {
  const managed = new InMemoryContextFactory().create({
    messages: [message("input")],
  });
  managed.controller.recordModelUsage({ inputTokens: 80 }, 1);
  await managed.context.append([message("new tail")]);

  const inspection = await managed.controller.inspect();
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.measuredInputTokens, 80);
  assert.equal(
    inspection.effectiveTokens,
    80 + Math.ceil(byteLength(message("new tail")) / 4),
  );
});

test("prunes old tool results and resets stale measurements", async () => {
  const oldTool = toolMessage("old", "x".repeat(4000));
  const recentTool = toolMessage("recent", "y".repeat(4000));
  const managed = new InMemoryContextFactory().create({
    messages: [oldTool, message("between"), recentTool],
    measurement: { inputTokens: 500, contextMessageCount: 2 },
    compactionStrategy: new PruneOldToolResultsStrategy({
      keepRecentToolResults: 1,
      minimumResultBytes: 0,
    }),
  });

  const result = await managed.controller.compact();
  assert.equal(result.strategy, "prune-old-tool-results");
  assert.equal(result.changed, true);
  assert.equal(result.before.measurementMethod, "measured+estimated");
  assert.equal(result.after.measurementMethod, "estimated");
  assert.ok(result.after.estimatedTokens < result.before.estimatedTokens);
  assert.match(result.messages[0].content[0].text, /tool result pruned/u);
  assert.deepEqual(result.messages[2], recentTool);
  assert.deepEqual((await managed.context.snapshot()).messages, result.messages);

  const repeated = await managed.controller.compact();
  assert.equal(repeated.changed, false);
});

test("summarizes complete old turns and retains the recent tail", async () => {
  const captured = [];
  const firstTool = toolMessage("first", "x".repeat(2000));
  const messages = [
    message("first request"),
    assistantToolMessage("first"),
    firstTool,
    message("second request"),
    assistantMessage("second answer"),
    message("recent request"),
    assistantMessage("recent answer"),
  ];
  const managed = new InMemoryContextFactory().create({
    messages,
    compactionStrategy: new SummaryTailStrategy({
      keepRecentTurns: 1,
      summarizer: {
        summarize(request) {
          captured.push(request.messages);
          return "The first request used a tool; the second was answered.";
        },
      },
    }),
  });

  const result = await managed.controller.compact();
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "summary-tail");
  assert.deepEqual(captured[0], messages.slice(0, 5));
  assert.match(
    result.messages[0].content[0].text,
    /Earlier conversation summary/u,
  );
  assert.deepEqual(result.messages.slice(1), messages.slice(5));
  assert.ok(result.after.estimatedTokens < result.before.estimatedTokens);
});

test("does not summarize when there are too few turns", async () => {
  let called = false;
  const managed = new InMemoryContextFactory().create({
    messages: [message("only turn"), assistantMessage("answer")],
    compactionStrategy: new SummaryTailStrategy({
      keepRecentTurns: 2,
      summarizer: {
        summarize() {
          called = true;
          return "unused";
        },
      },
    }),
  });

  const result = await managed.controller.compact();
  assert.equal(result.changed, false);
  assert.equal(called, false);
});

test("does not apply a summary that would increase context size", async () => {
  const messages = [
    message("one"),
    assistantMessage("one"),
    message("two"),
    assistantMessage("two"),
  ];
  const managed = new InMemoryContextFactory().create({
    messages,
    compactionStrategy: new SummaryTailStrategy({
      keepRecentTurns: 1,
      summarizer: {
        summarize() {
          return "larger ".repeat(1000);
        },
      },
    }),
  });

  const result = await managed.controller.compact();
  assert.equal(result.changed, false);
  assert.deepEqual((await managed.context.snapshot()).messages, messages);
});

test("rejects an empty summary without changing context", async () => {
  const messages = [
    message("one"),
    assistantMessage("answer"),
    message("two"),
  ];
  const managed = new InMemoryContextFactory().create({
    messages,
    compactionStrategy: new SummaryTailStrategy({
      keepRecentTurns: 1,
      summarizer: { summarize: () => "  " },
    }),
  });

  await assert.rejects(
    managed.controller.compact(),
    /empty summary/u,
  );
  assert.deepEqual((await managed.context.snapshot()).messages, messages);
});

function message(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolMessage(id, value) {
  return {
    role: "tool",
    toolCallId: id,
    name: "read",
    content: [{ type: "json", value }],
  };
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolMessage(id) {
  return {
    role: "assistant",
    content: [],
    toolCalls: [{ id, name: "read", input: { path: "file.txt" } }],
  };
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
