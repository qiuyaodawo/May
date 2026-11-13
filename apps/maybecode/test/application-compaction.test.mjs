import assert from "node:assert/strict";
import test from "node:test";
import { createTestWorkspace as temporaryDirectory } from "./fixtures/workspace.mjs";
import { assistantMessage, collectEvents } from "./fixtures/application.mjs";

import { RunCancelledError } from "@sortedyuan/may/core";
import { ModelContextCompactionStrategy } from "@sortedyuan/may/context";
import { OpenAIResponsesModel } from "@sortedyuan/providers";
import { InMemorySessionCatalog } from "@sortedyuan/may/session/catalog";
import { MaybeCodeWorkspace } from "../dist/workspace.js";

test("persists the default prune-and-summary view across resume", async () => {
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  const summarized = [];
  let modelCall = 0;
  const model = {
    async *stream(request) {
      requests.push(request);
      modelCall += 1;
      if (modelCall === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: Array.from({ length: 5 }, (_, index) => ({
              id: `large_${index}`,
              name: "large",
              input: { index },
            })),
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${modelCall} ${"x".repeat(1500)}`),
      };
    },
  };
  const options = {
    workspace: process.cwd(),
    model,
    store,
    catalog,
    tools: [
      {
        name: "large",
        description: "Returns a large result",
        inputSchema: { type: "object" },
        async execute(input) {
          return { index: input.index, payload: "x".repeat(4000) };
        },
      },
    ],
    permissionPolicy: () => "allow",
    subagents: false,
    contextSummarizer: {
      summarize(request) {
        summarized.push(request.messages);
        return "The first request was completed successfully.";
      },
    },
  };

  const first = await MaybeCodeWorkspace.open({ ...options, git: false, requestRecording: "off", autoResume: false });
  await (
    await first.submit({ input: "first request" })
  ).result;
  await (
    await first.submit({ input: "second request" })
  ).result;
  await (
    await first.submit({ input: "third request" })
  ).result;
  const result = await first.compactContext();
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "prune+summary-tail");
  const summarizedTools = summarized[0].filter((message) => message.role === "tool");
  assert.equal(summarizedTools.length, 5);
  assert.match(summarizedTools[0].content[0].text, /tool result pruned/u);
  assert.equal(summarizedTools[4].content[0].value.index, 4);
  assert.equal((await first.history()).filter((event) => event.type === "context.compacted").length, 1);
  await first.close();

  const resumed = await MaybeCodeWorkspace.open({ ...options, git: false, requestRecording: "off", autoResume: true });
  await (
    await resumed.submit({ input: "fourth request" })
  ).result;
  const resumedRequest = requests.at(-1);
  assert.ok(
    resumedRequest.messages.some(
      (message) =>
        message.role === "system" &&
        message.content[0]?.type === "text" &&
        message.content[0].text.includes("Earlier conversation summary"),
    ),
  );
  assert.equal(
    resumedRequest.messages.some(
      (message) =>
        message.role === "user" && message.content[0]?.type === "text" && message.content[0].text === "first request",
    ),
    false,
  );
  await resumed.close();
});

test("automatically compacts before a model call and persists the active view", async (t) => {
  const workspace = await temporaryDirectory(t);
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  let modelCall = 0;
  const model = {
    async *stream(request) {
      requests.push(request);
      modelCall += 1;
      yield {
        type: "response.completed",
        message: assistantMessage(modelCall === 1 ? `large ${"x".repeat(2500)}` : "done"),
      };
    },
  };
  const events = [];
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace,
    instructions: "Use the available tools.",
    model,
    store,
    catalog,
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    subagents: false,
    autoCompactionStrategies: [
      {
        name: "keep-current-input",
        compact(snapshot) {
          return snapshot.messages.length < 3 ? snapshot.messages : snapshot.messages.slice(-1);
        },
      },
    ],
  });
  const eventReader = collectEvents(app, events, "allow");

  await (
    await app.submit({ input: "first" })
  ).result;
  await (
    await app.submit({ input: "second" })
  ).result;

  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(requests[1].messages[1].content[0].text, "second");
  const history = await app.history();
  const compacted = history.filter((event) => event.type === "context.compacted");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].strategy, "keep-current-input");
  assert.deepEqual(compacted[0].messages, [
    {
      role: "user",
      content: [{ type: "text", text: "second" }],
    },
  ]);

  await app.close();
  await eventReader;
  assert.equal(events.filter((event) => event.type === "context.compacted").length, 1);
});

test("persists automatic compaction after the run events it contains", async (t) => {
  const workspace = await temporaryDirectory(t);
  const { InMemorySessionStore, Session } = await import("@sortedyuan/may/session");
  const backing = new InMemorySessionStore();
  let releaseAssistant;
  const assistantGate = new Promise((resolve) => {
    releaseAssistant = resolve;
  });
  let assistantAppendStarted;
  const assistantStarted = new Promise((resolve) => {
    assistantAppendStarted = resolve;
  });
  let delayedAssistant = false;
  const store = {
    read: (sessionId) => backing.read(sessionId),
    async append(event) {
      if (event.type === "assistant.completed" && !delayedAssistant) {
        delayedAssistant = true;
        assistantAppendStarted();
        await assistantGate;
      }
      await backing.append(event);
    },
  };
  let compactionDidStart;
  const compactionStarted = new Promise((resolve) => {
    compactionDidStart = resolve;
  });
  let modelCall = 0;
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace,
    instructions: "Use the available tools.",
    subagents: false,
    model: {
      async *stream() {
        modelCall += 1;
        yield modelCall === 1
          ? {
              type: "response.completed",
              message: {
                role: "assistant",
                content: [],
                toolCalls: [{ id: "large_1", name: "large", input: {} }],
              },
            }
          : {
              type: "response.completed",
              message: assistantMessage("done"),
            };
      },
    },
    tools: [
      {
        name: "large",
        description: "Returns enough data to trigger compaction",
        inputSchema: { type: "object" },
        async execute() {
          return { payload: "x".repeat(5000) };
        },
      },
    ],
    permissionPolicy: () => "allow",
    store,
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 2000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [
      {
        name: "drop-input",
        compact(snapshot) {
          compactionDidStart();
          return snapshot.messages
            .slice(1)
            .map((message) =>
              message.role === "tool" ? { ...message, content: [{ type: "json", value: { pruned: true } }] } : message,
            );
        },
      },
    ],
  });

  const run = await app.submit({ input: "use the large tool" });
  await assistantStarted;
  assert.equal(modelCall, 1, "the next step must wait for the assistant checkpoint");
  releaseAssistant();
  await compactionStarted;
  await run.result;

  const history = await app.history();
  const toolIndex = history.findIndex((event) => event.type === "tool.completed");
  const compactionIndex = history.findIndex((event) => event.type === "context.compacted");
  assert.ok(toolIndex >= 0);
  assert.ok(compactionIndex > toolIndex);

  let replayed;
  await Session.resume({
    id: app.sessionId,
    store,
    requestRecording: "off",
    createRuntime(messages) {
      replayed = messages;
      return {};
    },
  });
  assert.equal(replayed.filter((message) => message.role === "tool" && message.toolCallId === "large_1").length, 1);
  await app.close();
});

test("falls back when OpenAI native compaction returns 503 and exposes the failure", async (t) => {
  const workspace = await temporaryDirectory(t);
  const urls = [];
  const model = new OpenAIResponsesModel({
    apiKey: "test-key",
    model: "gpt-test",
    baseURL: "https://example.test/v1",
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/responses/compact")) {
        return new Response(
          JSON.stringify({
            error: { message: "compact service unavailable", type: "server_error" },
          }),
          { status: 503 },
        );
      }
      return openAIResponse("fallback worked");
    },
  });
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
  const events = [];
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace,
    instructions: "Use the available tools.",
    model,
    store,
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    subagents: false,
    autoCompactionStrategies: [
      new ModelContextCompactionStrategy(model.contextCompactor),
      {
        name: "offline-fallback",
        compact() {
          return [
            {
              role: "user",
              content: [{ type: "text", text: "Continue after fallback." }],
            },
          ];
        },
      },
    ],
  });
  const eventReader = collectEvents(app, events, "allow");

  const result = await (await app.submit({ input: "x".repeat(2500) })).result;
  assert.equal(result.message.content[0].text, "fallback worked");
  assert.deepEqual(urls, ["https://example.test/v1/responses/compact", "https://example.test/v1/responses"]);

  await app.close();
  await eventReader;
  const failed = events.find((event) => event.type === "context.compaction.failed");
  assert.equal(failed.strategy, "openai-responses-compact");
  assert.equal(failed.automatic, true);
  assert.equal(failed.error.name, "OpenAIResponsesError");
  assert.equal(failed.error.message, "compact service unavailable");
  assert.equal(failed.continuing, true);
  assert.equal(failed.before.shouldCompact, true);
  assert.equal(
    events.some((event) => event.type === "context.compacted" && event.strategy === "offline-fallback"),
    true,
  );
  assert.equal(
    (await app.history()).some((event) => event.type === "context.compaction.failed"),
    false,
  );
});

test("cancels an active summary compaction without persisting it", async () => {
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
  let summaryStarted;
  const started = new Promise((resolve) => {
    summaryStarted = resolve;
  });
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace: process.cwd(),
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistantMessage(`answer ${"x".repeat(1000)}`),
        };
      },
    },
    store,
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextSummarizer: {
      summarize({ signal }) {
        summaryStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new RunCancelledError("summary stopped")), { once: true });
        });
      },
    },
  });
  for (const input of ["one", "two", "three"]) {
    await (
      await app.submit({ input })
    ).result;
  }

  const compaction = app.compactContext();
  await started;
  assert.equal(app.isRunning, true);
  assert.equal(app.cancel("summary stopped"), true);
  await assert.rejects(compaction, RunCancelledError);
  assert.equal(
    (await app.history()).some((event) => event.type === "context.compacted"),
    false,
  );
  await app.close();
});

function openAIResponse(text) {
  const event = {
    type: "response.completed",
    response: {
      id: "resp_test",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
