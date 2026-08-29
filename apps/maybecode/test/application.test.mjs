import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext, RunCancelledError } from "@may/core";
import {
  ContextCompactionExhaustedError,
  ModelContextCompactionStrategy,
  PruneOldToolResultsStrategy,
} from "@may/context";
import { OpenAIResponsesModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import {
  InMemorySessionCatalog,
  MaybeCodeWorkspace,
} from "../dist/index.js";

test("runs coding tools and reuses an approved session grant", async (t) => {
  const workspace = await temporaryDirectory(t);
  const events = [];
  let modelCall = 0;
  const model = {
    async *stream() {
      modelCall += 1;
      if (modelCall === 1 || modelCall === 3) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{
              id: `write_${modelCall}`,
              name: "write",
              input: {
                path: "result.txt",
                content: modelCall === 1 ? "first" : "second",
              },
            }],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage(modelCall === 2 ? "created" : "updated"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new FileSessionStore(join(workspace, ".sessions")),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  const eventReader = collectEvents(app, events, "allow-session");

  assert.equal(
    (await (await app.submit({ input: "create result" })).result).message
      .content[0].text,
    "created",
  );
  assert.equal(
    (await (await app.submit({ input: "update result" })).result).message
      .content[0].text,
    "updated",
  );
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "second");

  const history = await app.history();
  assert.equal(
    history.filter((event) => event.type === "approval.requested").length,
    1,
  );
  assert.ok(
    history.findIndex((event) => event.type === "approval.resolved") <
      history.findIndex((event) => event.type === "tool.completed"),
  );

  await app.close();
  await eventReader;
  assert.equal(
    events.filter((event) =>
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ).length,
    1,
  );
  const previews = events.filter((event) => event.type === "change.preview");
  assert.deepEqual(
    previews.map((event) => event.preview.status === "ready" && event.preview.kind),
    ["create", "update"],
  );
});

test("executes read, write, edit, and bash through the application", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "source.txt"), "source", "utf8");
  const calls = [
    { id: "read", name: "read", input: { path: "source.txt" } },
    {
      id: "write",
      name: "write",
      input: { path: "target.txt", content: "old" },
    },
    {
      id: "edit",
      name: "edit",
      input: { path: "target.txt", oldText: "old", newText: "new" },
    },
    {
      id: "bash",
      name: "bash",
      input: { command: "node -e \"process.stdout.write('verified')\"" },
    },
  ];
  let modelCall = 0;
  const model = {
    async *stream() {
      const call = calls[modelCall++];
      yield {
        type: "response.completed",
        message: call === undefined
          ? assistantMessage("done")
          : { role: "assistant", content: [], toolCalls: [call] },
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  const events = [];
  const eventReader = collectEvents(app, events, "allow");

  await (await app.submit({ input: "use every tool" })).result;
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "new");
  await app.close();
  await eventReader;

  const completed = events
    .filter((event) =>
      event.type === "run.event" && event.event.type === "tool.completed"
    )
    .map((event) => event.event);
  assert.deepEqual(completed.map((event) => event.call.name), [
    "read",
    "write",
    "edit",
    "bash",
  ]);
  assert.equal(completed[3].output.stdout, "verified");
});

test("exposes bounded active-session history as an approval-free tool", async () => {
  let modelCall = 0;
  let historyOutput;
  const model = {
    async *stream(request) {
      modelCall += 1;
      if (modelCall === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{
              id: "history_1",
              name: "session_history",
              input: { order: "desc", limit: 5 },
            }],
          },
        };
        return;
      }
      historyOutput = request.messages.find((message) =>
        message.role === "tool" && message.name === "session_history"
      )?.content[0]?.value;
      yield {
        type: "response.completed",
        message: assistantMessage("history inspected"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  await (await app.submit({ input: "inspect this session" })).result;

  assert.ok(Array.isArray(historyOutput.events));
  assert.ok(historyOutput.events.some((event) =>
    event.type === "input.submitted"
  ));
  assert.equal(
    (await app.history()).some((event) => event.type === "approval.requested"),
    false,
  );
  await app.close();
});

test("auto-resumes, lists, creates, and switches workspace sessions", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  const model = {
    limits: { contextWindowTokens: 10000, maxOutputTokens: 1000 },
    async *stream(request) {
      requests.push(request);
      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${requests.length}`),
        usage: {
          inputTokens: 100 * requests.length,
          outputTokens: 10,
          totalTokens: 100 * requests.length + 10,
        },
      };
    },
  };
  const options = {
    workspace: process.cwd(),
    model,
    store,
    catalog,
  };

  const first = await MaybeCodeWorkspace.open({ ...options, autoResume: false });
  const firstId = first.sessionId;
  await (await first.submit({ input: "first" })).result;
  await first.close();

  const resumed = await MaybeCodeWorkspace.open(options);
  assert.equal(resumed.sessionId, firstId);
  const inspection = await resumed.inspectContext();
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.measuredInputTokens, 100);
  assert.ok(inspection.effectiveTokens > 100);
  assert.equal(inspection.contextWindowTokens, 10000);
  await (await resumed.submit({ input: "second" })).result;
  assert.deepEqual(requests[1].messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "user",
  ]);

  const secondId = await resumed.newSession();
  assert.notEqual(secondId, firstId);
  assert.equal((await resumed.listSessions()).length, 2);
  await resumed.resumeSession(firstId);
  assert.equal(resumed.sessionId, firstId);
  await resumed.close();
});

test("creates context through an injected factory for each session", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const inputs = [];
  const contexts = [];
  const contextFactory = {
    async create(options) {
      inputs.push(options);
      const context = new InMemoryContext({
        instructions: options.instructions,
        messages: [...(options.messages ?? [])],
        metadata: { ...options.metadata },
      });
      contexts.push(context);
      return { context };
    },
  };
  const model = {
    async *stream() {
      yield {
        type: "response.completed",
        message: assistantMessage("answer"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store,
    catalog,
    contextFactory,
    autoResume: false,
  });

  const firstId = app.sessionId;
  await (await app.submit({ input: "first" })).result;
  await app.newSession();
  await app.resumeSession(firstId);

  assert.equal(inputs.length, 3);
  assert.equal(new Set(contexts).size, 3);
  assert.deepEqual(inputs.map((input) => input.messages?.length ?? 0), [0, 0, 2]);
  assert.equal(inputs[0].instructions, inputs[2].instructions);
  assert.deepEqual(inputs[0].metadata, { workspace: process.cwd() });
  assert.equal(await app.inspectContext(), undefined);
  await assert.rejects(
    app.compactContext(),
    /compaction is not supported/u,
  );
  await app.close();
});

test("persists pruned tool results across session resume", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
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
            toolCalls: [
              { id: "old", name: "large", input: { label: "old" } },
              { id: "recent", name: "large", input: { label: "recent" } },
            ],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${modelCall}`),
      };
    },
  };
  const options = {
    workspace: process.cwd(),
    model,
    store,
    catalog,
    tools: [{
      name: "large",
      description: "Returns a large result",
      inputSchema: { type: "object" },
      async execute(input) {
        return { label: input.label, payload: "x".repeat(4000) };
      },
    }],
    permissionPolicy: () => "allow",
    compactionStrategy: new PruneOldToolResultsStrategy({
      keepRecentToolResults: 1,
      minimumResultBytes: 0,
    }),
  };

  const first = await MaybeCodeWorkspace.open({ ...options, autoResume: false });
  await (await first.submit({ input: "produce results" })).result;
  const compacted = await first.compactContext();
  assert.equal(compacted.changed, true);
  assert.ok(compacted.after.estimatedTokens < compacted.before.estimatedTokens);
  assert.equal(
    (await first.history()).filter((event) =>
      event.type === "context.compacted"
    ).length,
    1,
  );
  await first.close();

  const resumed = await MaybeCodeWorkspace.open(options);
  await (await resumed.submit({ input: "continue" })).result;
  const toolMessages = requests.at(-1).messages.filter((message) =>
    message.role === "tool"
  );
  assert.match(toolMessages[0].content[0].text, /tool result pruned/u);
  assert.equal(toolMessages[1].content[0].value.label, "recent");
  await resumed.close();
});

test("persists a summary-tail view across session resume", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  const summarized = [];
  let modelCall = 0;
  const model = {
    async *stream(request) {
      requests.push(request);
      modelCall += 1;
      yield {
        type: "response.completed",
        message: assistantMessage(
          `answer ${modelCall} ${"x".repeat(1500)}`,
        ),
      };
    },
  };
  const options = {
    workspace: process.cwd(),
    model,
    store,
    catalog,
    contextSummarizer: {
      summarize(request) {
        summarized.push(request.messages);
        return "The first request was completed successfully.";
      },
    },
  };

  const first = await MaybeCodeWorkspace.open({ ...options, autoResume: false });
  await (await first.submit({ input: "first request" })).result;
  await (await first.submit({ input: "second request" })).result;
  await (await first.submit({ input: "third request" })).result;
  const result = await first.compactContext("summary-tail");
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "summary-tail");
  assert.deepEqual(
    summarized[0].map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(
    (await first.history()).at(-1).type,
    "context.compacted",
  );
  await first.close();

  const resumed = await MaybeCodeWorkspace.open(options);
  await (await resumed.submit({ input: "fourth request" })).result;
  const resumedRequest = requests.at(-1);
  assert.ok(
    resumedRequest.messages.some((message) =>
      message.role === "system" &&
      message.content[0]?.type === "text" &&
      message.content[0].text.includes("Earlier conversation summary")
    ),
  );
  assert.equal(
    resumedRequest.messages.some((message) =>
      message.role === "user" &&
      message.content[0]?.type === "text" &&
      message.content[0].text === "first request"
    ),
    false,
  );
  await resumed.close();
});

test("persists a history-reference view with the latest turn", async () => {
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${requests.length} ${"x".repeat(600)}`),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  for (const input of ["first", "second", "current"]) {
    await (await app.submit({ input })).result;
  }

  const result = await app.compactContext("history-reference");

  assert.equal(result.changed, true);
  assert.equal(result.strategy, "history-reference");
  assert.deepEqual(result.messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
  ]);
  assert.match(result.messages[0].content[0].text, /session_history/u);
  assert.equal(result.messages[1].content[0].text, "current");
  assert.equal((await app.history()).at(-1).type, "context.compacted");
  await app.close();
});

test("automatically compacts before a model call and persists the active view", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  let modelCall = 0;
  const model = {
    async *stream(request) {
      requests.push(request);
      modelCall += 1;
      yield {
        type: "response.completed",
        message: assistantMessage(
          modelCall === 1 ? `large ${"x".repeat(2500)}` : "done",
        ),
      };
    },
  };
  const events = [];
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store,
    catalog,
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [{
      name: "keep-current-input",
      compact(snapshot) {
        return snapshot.messages.length < 3
          ? snapshot.messages
          : snapshot.messages.slice(-1);
      },
    }],
  });
  const eventReader = collectEvents(app, events, "allow");

  await (await app.submit({ input: "first" })).result;
  await (await app.submit({ input: "second" })).result;

  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(requests[1].messages[1].content[0].text, "second");
  const history = await app.history();
  const compacted = history.filter((event) =>
    event.type === "context.compacted"
  );
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].strategy, "keep-current-input");
  assert.deepEqual(compacted[0].messages, [{
    role: "user",
    content: [{ type: "text", text: "second" }],
  }]);

  await app.close();
  await eventReader;
  assert.equal(
    events.filter((event) => event.type === "context.compacted").length,
    1,
  );
});

test("falls back when OpenAI native compaction returns 503 and exposes the failure", async () => {
  const urls = [];
  const model = new OpenAIResponsesModel({
    apiKey: "test-key",
    model: "gpt-test",
    baseURL: "https://example.test/v1",
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/responses/compact")) {
        return new Response(JSON.stringify({
          error: { message: "compact service unavailable", type: "server_error" },
        }), { status: 503 });
      }
      return openAIResponse("fallback worked");
    },
  });
  const store = new (await import("@may/session")).InMemorySessionStore();
  const events = [];
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store,
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [
      new ModelContextCompactionStrategy(model.contextCompactor),
      {
        name: "offline-fallback",
        compact() {
          return [{
            role: "user",
            content: [{ type: "text", text: "Continue after fallback." }],
          }];
        },
      },
    ],
  });
  const eventReader = collectEvents(app, events, "allow");

  const result = await (await app.submit({ input: "x".repeat(2500) })).result;
  assert.equal(result.message.content[0].text, "fallback worked");
  assert.deepEqual(urls, [
    "https://example.test/v1/responses/compact",
    "https://example.test/v1/responses",
  ]);

  await app.close();
  await eventReader;
  const failed = events.find((event) =>
    event.type === "context.compaction.failed"
  );
  assert.equal(failed.strategy, "openai-responses-compact");
  assert.equal(failed.automatic, true);
  assert.equal(failed.error.name, "OpenAIResponsesError");
  assert.equal(failed.error.message, "compact service unavailable");
  assert.equal(failed.continuing, true);
  assert.equal(failed.before.shouldCompact, true);
  assert.equal(
    events.some((event) =>
      event.type === "context.compacted" &&
      event.strategy === "offline-fallback"
    ),
    true,
  );
  assert.equal(
    (await app.history()).some((event) =>
      event.type === "context.compaction.failed"
    ),
    false,
  );
});

test("fails the run explicitly when automatic compaction is exhausted", async () => {
  let modelCalled = false;
  const events = [];
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model: {
      async *stream() {
        modelCalled = true;
        yield { type: "response.completed", message: assistantMessage("no") };
      },
    },
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [{
      name: "always-broken",
      compact() {
        throw new Error("offline fault injection");
      },
    }],
  });
  const eventReader = collectEvents(app, events, "allow");

  await assert.rejects(
    (await app.submit({ input: "x".repeat(2500) })).result,
    (error) => {
      assert.equal(error instanceof ContextCompactionExhaustedError, true);
      assert.equal(error.failures.length, 1);
      return true;
    },
  );
  assert.equal(modelCalled, false);
  const history = await app.history();
  assert.equal(history.at(-1).type, "run.failed");
  assert.equal(history.at(-1).error.name, "ContextCompactionExhaustedError");

  await app.close();
  await eventReader;
  const failure = events.find((event) =>
    event.type === "context.compaction.failed"
  );
  assert.equal(failure.strategy, "always-broken");
  assert.equal(failure.continuing, false);
  assert.equal(
    events.some((event) =>
      event.type === "run.event" &&
      event.event.type === "run.failed" &&
      event.event.error.name === "ContextCompactionExhaustedError"
    ),
    true,
  );
});

test("cancels an active summary compaction without persisting it", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  let summaryStarted;
  const started = new Promise((resolve) => {
    summaryStarted = resolve;
  });
  const app = await MaybeCodeWorkspace.open({
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
          signal.addEventListener(
            "abort",
            () => reject(new RunCancelledError("summary stopped")),
            { once: true },
          );
        });
      },
    },
  });
  for (const input of ["one", "two", "three"]) {
    await (await app.submit({ input })).result;
  }

  const compaction = app.compactContext("summary-tail");
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

test("cancels an active model call", async () => {
  let started;
  const modelStarted = new Promise((resolve) => {
    started = resolve;
  });
  const model = {
    async *stream(_request, { signal }) {
      started();
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      yield {
        type: "response.completed",
        message: assistantMessage("unreachable"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  const run = await app.submit({ input: "wait" });
  await modelStarted;
  await assert.rejects(
    app.compactContext(),
    /while an operation is active/u,
  );
  assert.equal(app.cancel("stop"), true);
  await assert.rejects(run.result, RunCancelledError);
  await app.close();
});

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function openAIResponse(text) {
  const event = {
    type: "response.completed",
    response: {
      id: "resp_test",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      }],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectEvents(app, target, approvalDecision) {
  for await (const event of app.events) {
    target.push(event);
    if (
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ) {
      await app.resolveApproval(event.event.request.id, approvalDecision);
    }
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
