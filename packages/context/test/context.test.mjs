import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryReferenceStrategy,
  InMemoryContextFactory,
  ModelContextCompactionStrategy,
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
    budget: {
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
      toolReserveTokens: 50,
      safetyMarginTokens: 25,
      compactTriggerRatio: 0.9,
    },
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
  assert.equal(inspection.reservedTokens, 175);
  assert.equal(inspection.inputBudgetTokens, 825);
  assert.equal(
    inspection.remainingInputTokens,
    825 - inspection.effectiveTokens,
  );
  assert.equal(inspection.compactTriggerTokens, 825);
  assert.equal(inspection.shouldCompact, false);
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

test("replaces old turns with a durable history reference and keeps the current turn", async () => {
  const messages = [
    message("first"),
    assistantMessage("x".repeat(1000)),
    message("second"),
    assistantMessage("y".repeat(1000)),
    message("current request"),
  ];
  const managed = new InMemoryContextFactory().create({
    messages,
    compactionStrategy: new HistoryReferenceStrategy({
      reference: "Use the session_history tool to inspect earlier work.",
    }),
  });

  const result = await managed.controller.compact();

  assert.equal(result.changed, true);
  assert.equal(result.strategy, "history-reference");
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[0].content[0].text, /session_history/u);
  assert.deepEqual(result.messages.slice(1), [message("current request")]);
  assert.ok(result.after.estimatedTokens < result.before.estimatedTokens);
});

test("supports dynamic history references and cancellation", async () => {
  let called = false;
  const strategy = new HistoryReferenceStrategy({
    reference({ snapshot, signal }) {
      called = true;
      assert.equal(snapshot.messages.length, 3);
      signal.throwIfAborted();
      return "History resource: session://current";
    },
  });
  const managed = new InMemoryContextFactory().create({
    messages: [message("old"), assistantMessage("old"), message("current")],
    compactionStrategy: strategy,
  });
  const controller = new AbortController();
  controller.abort("stop reference");

  await assert.rejects(
    managed.controller.compact(undefined, { signal: controller.signal }),
    { name: "AbortError", message: "stop reference" },
  );
  assert.equal(called, false);
  assert.equal((await managed.controller.inspect()).messageCount, 3);
});

test("runs automatic compaction strategies in order before model snapshots", async () => {
  const calls = [];
  const recorded = [];
  const tail = message("tail");
  const managed = new InMemoryContextFactory().create({
    messages: [message("x".repeat(1000)), tail],
    budget: {
      contextWindowTokens: 200,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [
      {
        name: "no-op",
        compact(snapshot) {
          calls.push("no-op");
          return snapshot.messages;
        },
      },
      {
        name: "keep-tail",
        compact() {
          calls.push("keep-tail");
          return [tail];
        },
      },
    ],
  });
  managed.controller.setAutoCompactionSink((result) => recorded.push(result));

  const snapshot = await managed.context.snapshot();

  assert.deepEqual(calls, ["no-op", "keep-tail"]);
  assert.deepEqual(snapshot.messages, [tail]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].strategy, "keep-tail");
  assert.equal(recorded[0].before.shouldCompact, true);
  assert.equal(recorded[0].after.shouldCompact, false);

  await managed.context.snapshot();
  assert.deepEqual(calls, ["no-op", "keep-tail"]);
});

test("does not repeat exhausted automatic compaction until context changes", async () => {
  let calls = 0;
  const managed = new InMemoryContextFactory().create({
    messages: [message("x".repeat(1000))],
    budget: {
      contextWindowTokens: 100,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [{
      name: "no-op",
      compact(snapshot) {
        calls += 1;
        return snapshot.messages;
      },
    }],
  });

  await managed.context.snapshot();
  await managed.context.snapshot();
  assert.equal(calls, 1);

  await managed.context.append([message("new")]);
  await managed.context.snapshot();
  assert.equal(calls, 2);
});

test("cancels automatic compaction without replacing context", async () => {
  let started;
  const compactionStarted = new Promise((resolve) => {
    started = resolve;
  });
  const managed = new InMemoryContextFactory().create({
    messages: [message("x".repeat(1000))],
    budget: {
      contextWindowTokens: 100,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [{
      name: "waiting",
      compact(_snapshot, { signal }) {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("stopped");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    }],
  });
  const controller = new AbortController();
  const snapshot = managed.context.snapshot({ signal: controller.signal });
  await compactionStarted;
  controller.abort("stopped");

  await assert.rejects(snapshot, { name: "AbortError" });
  assert.equal((await managed.controller.inspect()).messageCount, 1);
});

test("uses provider-native compaction as a terminal strategy with measured size", async () => {
  let fallbackCalled = false;
  let receivedOptions;
  const compacted = {
    role: "assistant",
    content: [],
    modelState: {
      type: "provider.compaction.v1",
      data: { opaque: "state" },
    },
  };
  const native = new ModelContextCompactionStrategy({
    name: "provider-native",
    async compact(snapshot, options) {
      assert.equal(snapshot.messages.length, 1);
      receivedOptions = options;
      return { messages: [compacted], effectiveTokens: 20 };
    },
  });
  const managed = new InMemoryContextFactory().create({
    messages: [message("x".repeat(1000))],
    budget: {
      contextWindowTokens: 200,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [
      native,
      {
        name: "fallback",
        compact(snapshot) {
          fallbackCalled = true;
          return snapshot.messages;
        },
      },
    ],
  });

  const snapshot = await managed.context.snapshot({ runId: "run", step: 2 });
  const inspection = await managed.controller.inspect();

  assert.deepEqual(snapshot.messages, [compacted]);
  assert.equal(receivedOptions.runId, "run");
  assert.equal(receivedOptions.step, 2);
  assert.equal(fallbackCalled, false);
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.effectiveTokens, 20);
  assert.equal(inspection.shouldCompact, false);
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
