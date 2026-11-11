import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPendingServerToolInteraction,
  InMemoryContext,
  isStreamingMayEvent,
  May,
  ModelResponseValidationError,
  runtimeHooks,
  ServerToolContinuationLimitError,
  ToolUsageError,
  validateMessage,
} from "@sortedyuan/may/core";
import { InMemoryContextFactory, PruneOldToolResultsStrategy } from "@sortedyuan/may/context";
import { parseMayConfig } from "@sortedyuan/may/config";

const serverCall = (status = "pending") => ({ id: "search", kind: "web_search", name: "web_search", status });
const assistant = (extra = {}) => ({ role: "assistant", content: [], ...extra });
const pause = () => assistant({ continuation: "server-tool-pause", serverToolCalls: [serverCall()] });
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

async function events(run) {
  const result = [];
  for await (const event of run.events) result.push(event);
  return result;
}

test("server pause continues the real May loop with checkpointed messages and deferred input", async () => {
  const context = new InMemoryContext();
  const requests = [];
  const checkpoints = [];
  const boundaries = [];
  const may = new May({
    context,
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        yield { type: "server_tool.updated", call: serverCall(requests.length === 1 ? "pending" : "completed") };
        yield { type: "response.completed", message: requests.length === 1 ? pause() : assistant() };
      },
    },
  });
  const run = may.run({
    input: "search",
    checkpoint: async (event) => checkpoints.push(structuredClone(event)),
    stepInputSource: async ({ step }) => {
      boundaries.push(step);
      return [];
    },
  });
  const observed = events(run);
  const result = await run.result;
  assert.equal(result.steps, 2);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(boundaries, [2]);
  assert.deepEqual(requests[1].messages.at(-1), pause());
  assert.deepEqual(
    checkpoints.filter((event) => event.type === "model.completed").map((event) => event.message),
    [pause(), assistant()],
  );
  const updates = (await observed).filter((event) => event.type === "model.server_tool.updated");
  assert.equal(updates.length, 2);
  assert.ok(updates.every(isStreamingMayEvent));
});

test("continuation limits preserve paused history and continue starts from that message", async () => {
  const context = new InMemoryContext();
  let completed = false;
  const may = new May({
    context,
    model: {
      async *stream(request) {
        if (completed) assert.equal(request.messages.at(-1).continuation, "server-tool-pause");
        yield { type: "response.completed", message: completed ? assistant() : pause() };
      },
    },
  });
  await assert.rejects(may.run({ input: "search", maxServerToolContinuations: 2 }).result, (error) => {
    assert.ok(error instanceof ServerToolContinuationLimitError);
    assert.equal(error.continuations, 3);
    return true;
  });
  assert.equal((await context.snapshot()).messages.length, 4);
  completed = true;
  assert.equal((await may.continue().result).steps, 1);
  assert.throws(() => may.continue({ maxServerToolContinuations: -1 }), RangeError);
});

test("pause boundaries yield and continuation requests consume model-call budgets", async () => {
  const context = new InMemoryContext();
  const may = new May({
    context,
    model: {
      async *stream() {
        yield { type: "response.completed", message: pause(), usage };
      },
    },
  });
  assert.equal((await may.run({ input: "search", shouldYield: () => true }).result).finishReason, "yielded");
  assert.equal((await context.snapshot()).messages.at(-1).continuation, "server-tool-pause");
  await assert.rejects(may.continue({ runBudget: { maxModelCalls: 1 } }).result, { dimension: "modelCalls" });
  await assert.rejects(may.continue({ runBudget: { maxSteps: 1 } }).result, { dimension: "steps" });
});

test("pending mixed calls retain steering input until the server result arrives", async () => {
  let calls = 0;
  const boundaries = [];
  const may = new May({
    context: new InMemoryContext(),
    tools: [{ name: "read", description: "read", inputSchema: {}, execute: async () => "content" }],
    model: {
      async *stream(request) {
        calls += 1;
        if (calls === 2)
          assert.deepEqual(
            request.messages.map((message) => message.role),
            ["user", "assistant", "tool"],
          );
        if (calls === 3) assert.equal(request.messages.at(-1).content[0].text, "steering");
        yield {
          type: "response.completed",
          message:
            calls === 1
              ? assistant({ toolCalls: [{ id: "read", name: "read", input: {} }], serverToolCalls: [serverCall()] })
              : assistant({ serverToolCalls: [serverCall("completed")] }),
        };
      },
    },
  });
  const result = await may.run({
    input: "search",
    stepInputSource: async ({ step }) => {
      boundaries.push(step);
      return step === 2 ? [{ role: "user", content: [{ type: "text", text: "steering" }] }] : [];
    },
  }).result;
  assert.equal(result.steps, 3);
  assert.deepEqual(boundaries, [2, 3]);
});

test("rawInput is passed unchanged and withheld after input changes including in-place hooks", async () => {
  for (const change of ["none", "replace", "mutate"]) {
    const rawInput = '{ "query" : "May" }';
    let received;
    let calls = 0;
    const may = new May({
      context: new InMemoryContext(),
      hooks: {
        async observe() {},
        async transform(hook, value) {
          if (hook.name === "tool.before" && change === "replace") return { ...value, input: { query: "other" } };
          if (hook.name === "tool.before" && change === "mutate") value.input.query = "other";
          return value;
        },
      },
      tools: [
        {
          name: "search",
          description: "search",
          inputSchema: {},
          execute: async (_input, context) => {
            received = context.rawInput;
            return "done";
          },
        },
      ],
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            message:
              ++calls === 1
                ? assistant({ toolCalls: [{ id: "search", name: "search", input: { query: "May" }, rawInput }] })
                : assistant(),
          };
        },
      },
    });
    await may.run({ input: "search" }).result;
    assert.equal(received, change === "none" ? rawInput : undefined);
  }
});

test("tool usage is checkpointed, emitted, aggregated and charged against maxCostUsd", async () => {
  const searchUsage = { items: [{ id: "web-search", quantity: 1, unit: "requests", includedIn: "none" }] };
  for (const maxCostUsd of [1, 0.01]) {
    const checkpoints = [];
    let calls = 0;
    let executions = 0;
    const may = new May({
      context: new InMemoryContext(),
      tools: [
        {
          name: "search",
          description: "search",
          inputSchema: {},
          execute: async () => {
            executions += 1;
            return { usage: searchUsage };
          },
          usage: (output) => output.usage,
        },
      ],
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            usage,
            message:
              ++calls === 1
                ? assistant({
                    toolCalls: [
                      { id: "search", name: "search", input: {} },
                      ...(maxCostUsd < 1 ? [{ id: "second-search", name: "search", input: {} }] : []),
                    ],
                  })
                : assistant(),
          };
        },
      },
    });
    const run = may.run({
      input: "search",
      checkpoint: async (event) => checkpoints.push(event),
      runBudget: {
        maxCostUsd,
        pricing: {
          id: "test",
          version: "1",
          currency: "USD",
          source: "test",
          effectiveAt: "2026-11-07T00:00:00Z",
          inputPerMillion: 0,
          outputPerMillion: 0,
          items: { "web-search": { unit: "requests", perUnit: 0.1 } },
        },
      },
    });
    const observed = events(run);
    if (maxCostUsd === 1) {
      const result = await run.result;
      assert.deepEqual(result.usage.items, searchUsage.items);
      assert.equal(result.budget.costUsd, 0.1);
    } else {
      await assert.rejects(run.result, { dimension: "costUsd", consumed: 0.1 });
      assert.equal(calls, 1);
      assert.equal(executions, 1);
    }
    assert.deepEqual(checkpoints.find((event) => event.type === "tool.completed").usage, searchUsage);
    assert.deepEqual((await observed).find((event) => event.type === "tool.completed").usage, searchUsage);
  }
});

test("tool usage requires an explicit success method or ToolUsageError", async () => {
  const charged = { items: [{ id: "web-search", quantity: 1, unit: "requests", includedIn: "none" }] };
  for (const value of [
    "ordinary field",
    charged,
    null,
    new ModelResponseValidationError("invalid", { usage: charged }),
    new ToolUsageError("charged", charged, { cause: new Error("remote failure") }),
  ]) {
    let calls = 0;
    const may = new May({
      context: new InMemoryContext(),
      tools: [
        {
          name: "search",
          description: "search",
          inputSchema: {},
          async execute() {
            if (value instanceof Error) throw value;
            return { usage: value };
          },
        },
      ],
      model: {
        async *stream() {
          yield {
            type: "response.completed",
            usage,
            message:
              ++calls === 1 ? assistant({ toolCalls: [{ id: "search", name: "search", input: {} }] }) : assistant(),
          };
        },
      },
    });
    const run = may.run({ input: "search" });
    const observed = events(run);
    const result = await run.result;
    const outcome = (await observed).find((event) => event.type === "tool.completed" || event.type === "tool.failed");
    if (value instanceof ToolUsageError) {
      assert.deepEqual(result.usage.items, charged.items);
      assert.deepEqual(outcome.usage, charged);
      assert.equal(value.cause.message, "remote failure");
    } else {
      assert.equal(result.usage.items, undefined);
      assert.equal(outcome.usage, undefined);
    }
    assert.equal(outcome.type, value instanceof Error ? "tool.failed" : "tool.completed");
  }
});

test("server tool records and citation ranges are validated", () => {
  validateMessage(
    assistant({
      content: [
        {
          type: "text",
          text: "中😀",
          citations: [{ type: "url", url: "https://example.com", range: { start: 1, end: 3 } }],
        },
      ],
      serverToolCalls: [serverCall()],
    }),
  );
  for (const extra of [
    { serverToolCalls: [serverCall(), serverCall()] },
    { serverToolCalls: [{ ...serverCall(), id: "" }] },
    { serverToolCalls: [{ ...serverCall(), status: "other" }] },
    { serverToolCalls: [{ ...serverCall(), sources: [{}] }] },
    { continuation: "other" },
    { continuation: "server-tool-pause", toolCalls: [{ id: "x", name: "x", input: {} }] },
    { toolCalls: [{ id: "x", name: "x", input: {}, rawInput: 1 }] },
    ...[
      { start: -1, end: 1 },
      { start: 2, end: 1 },
      { start: 0, end: 4 },
      { start: 0.5, end: 1 },
    ].map((range) => ({
      content: [{ type: "text", text: "中😀", citations: [{ type: "url", url: "https://example.com", range }] }],
    })),
  ])
    assert.throws(() => validateMessage(assistant(extra)), TypeError);
  runtimeHooks.modelEvent.validate({ type: "server_tool.updated", call: serverCall() });
});

test("compaction protects unfinished interactions and postpones requested automatic work", async () => {
  const paused = assistant({ toolCalls: [{ id: "read", name: "read", input: {} }], serverToolCalls: [serverCall()] });
  const result = { role: "tool", toolCallId: "read", name: "read", content: [{ type: "text", text: "x".repeat(100) }] };
  const pruning = new PruneOldToolResultsStrategy({ keepRecentToolResults: 0, minimumResultBytes: 0 });
  assert.deepEqual(pruning.compact({ messages: [paused, result] }), [paused, result]);
  assert.equal(hasPendingServerToolInteraction([paused, result]), true);
  assert.equal(hasPendingServerToolInteraction([paused, result, assistant()]), false);
  const managed = new InMemoryContextFactory().create({ messages: [paused, result] });
  const replacement = { name: "remove-history", compact: () => [] };
  await managed.controller.compact(replacement);
  assert.deepEqual((await managed.context.snapshot()).messages, [paused, result]);
  managed.controller.requestCompaction(replacement);
  assert.deepEqual(await managed.controller.prepareForModel(), []);
  await managed.context.append([assistant()]);
  await managed.controller.prepareForModel();
  assert.deepEqual((await managed.context.snapshot()).messages, []);
});

test("webSearch schema validates adapter options and inherited model adapters", () => {
  for (const [adapter, webSearch] of [
    ["anthropic-messages", {}],
    ["openai-responses", {}],
    ["openai-chat-completions", {}],
    ["google-gemini", {}],
    ["zhipu-chat", { searchEngine: "search_std" }],
  ]) {
    for (const value of [false, webSearch])
      parseMayConfig({
        providers: { p: { adapter, options: { webSearch: value } } },
        models: { m: { provider: "p", model: "model", options: { webSearch: value } } },
      });
  }
  for (const [adapter, webSearch] of [
    ["deepseek-chat", false],
    ["kimi-chat", {}],
    ["anthropic-messages", { allowedDomains: [], blockedDomains: [] }],
    ["anthropic-messages", { responseInclusion: "full" }],
    ["openai-responses", { userLocation: {} }],
    ["openai-chat-completions", { allowedDomains: ["example.com"] }],
    ["google-gemini", { timeRange: { startTime: "2026-11-07T00:00:00Z" } }],
    ["zhipu-chat", {}],
  ]) {
    assert.throws(() => parseMayConfig({ providers: { p: { adapter, options: { webSearch } } } }));
    assert.throws(() =>
      parseMayConfig({
        providers: { p: { adapter } },
        models: { m: { provider: "p", model: "model", options: { webSearch } } },
      }),
    );
  }
  parseMayConfig({
    providers: {
      p: {
        adapter: "anthropic-messages",
        capabilities: {
          fields: {
            "serverTools.webSearch": true,
            "serverTools.webSearchWithFunctions": true,
            "serverTools.alwaysSearches": false,
          },
        },
      },
    },
  });
});
