import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext, RunCancelledError } from "@may/core";
import { ModelContextCompactionStrategy } from "@may/context";
import { OpenAIResponsesModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import {
  InMemorySessionCatalog,
  MaybeCodeWorkspace,
  TranscriptStore,
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
  const sessionDirectory = join(workspace, ".sessions");
  const catalog = new InMemorySessionCatalog();
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new FileSessionStore(sessionDirectory),
    catalog,
    autoResume: false,
  });
  const sessionId = app.sessionId;
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
  const persistedPreviews = history.filter(
    (event) => event.type === "tool.presentation",
  );
  assert.deepEqual(
    persistedPreviews.map((event) => [event.kind, event.version, event.data.kind]),
    [
      ["maybecode.change-preview", 1, "create"],
      ["maybecode.change-preview", 1, "update"],
    ],
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

  const resumed = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new FileSessionStore(sessionDirectory),
    catalog,
    sessionId,
  });
  const restoredTranscript = new TranscriptStore();
  restoredTranscript.loadHistory(await resumed.history());
  assert.deepEqual(
    restoredTranscript.items
      .filter((item) => item.kind === "tool")
      .map((item) => item.preview?.kind),
    ["create", "update"],
  );
  await resumed.close();
});

test("retries a failed run after resuming its durable session", async (t) => {
  const workspace = await temporaryDirectory(t);
  const store = new FileSessionStore(join(workspace, ".sessions"));
  const catalog = new InMemorySessionCatalog();
  const first = await MaybeCodeWorkspace.open({
    workspace,
    model: {
      async *stream() {
        throw new Error("provider offline");
      },
    },
    store,
    catalog,
    autoResume: false,
  });
  const sessionId = first.sessionId;
  await assert.rejects(
    (await first.submit({ input: "keep this request" })).result,
    /provider offline/,
  );
  await first.close();

  let request;
  const resumed = await MaybeCodeWorkspace.open({
    workspace,
    model: {
      async *stream(value) {
        request = value;
        yield {
          type: "response.completed",
          message: assistantMessage("resumed and recovered"),
        };
      },
    },
    store,
    catalog,
    autoResume: true,
  });
  assert.equal(resumed.sessionId, sessionId);
  await (await resumed.retry()).result;
  assert.equal(
    request.messages.filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(request.messages.find((message) => message.role === "user")
    .content[0].text, "keep this request");
  assert.equal(
    (await resumed.history()).filter((event) =>
      event.type === "input.submitted"
    ).length,
    1,
  );
  await resumed.close();
});

test("executes read, write, edit, and shell through the application", async (t) => {
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
      id: "shell",
      name: "shell",
      input: { command: "node -e \"process.stdout.write('verified')\"" },
    },
  ];
  let modelCall = 0;
  let firstRequest;
  const model = {
    async *stream(request) {
      firstRequest ??= request;
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
    "shell",
  ]);
  assert.equal(completed[3].output.stdout, "verified");
  const shellDefinition = firstRequest.tools.find((tool) => tool.name === "shell");
  assert.match(
    shellDefinition.description,
    process.platform === "win32" ? /PowerShell/u : /Bash/u,
  );
  assert.match(
    firstRequest.messages[0].content[0].text,
    process.platform === "win32"
      ? /shell tool runs (?:Windows PowerShell|PowerShell 7)/u
      : /shell tool runs Bash/u,
  );
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

test("starts fresh by default and explicitly resumes workspace sessions", async () => {
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

  const resumed = await MaybeCodeWorkspace.open({ ...options, autoResume: true });
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

  const fresh = await MaybeCodeWorkspace.open(options);
  assert.notEqual(fresh.sessionId, firstId);
  await fresh.close();
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

test("persists the default prune-and-summary view across resume", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
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
    tools: [{
      name: "large",
      description: "Returns a large result",
      inputSchema: { type: "object" },
      async execute(input) {
        return { index: input.index, payload: "x".repeat(4000) };
      },
    }],
    permissionPolicy: () => "allow",
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
  const result = await first.compactContext();
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "prune+summary-tail");
  const summarizedTools = summarized[0].filter((message) =>
    message.role === "tool"
  );
  assert.equal(summarizedTools.length, 5);
  assert.match(summarizedTools[0].content[0].text, /tool result pruned/u);
  assert.equal(summarizedTools[4].content[0].value.index, 4);
  assert.equal(
    (await first.history()).filter((event) => event.type === "context.compacted")
      .length,
    1,
  );
  await first.close();

  const resumed = await MaybeCodeWorkspace.open({ ...options, autoResume: true });
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

test("persists automatic compaction after the run events it contains", async () => {
  const { InMemorySessionStore, Session } = await import("@may/session");
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
    workspace: process.cwd(),
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
    tools: [{
      name: "large",
      description: "Returns enough data to trigger compaction",
      inputSchema: { type: "object" },
      async execute() {
        return { payload: "x".repeat(5000) };
      },
    }],
    permissionPolicy: () => "allow",
    store,
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 2000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [{
      name: "drop-input",
      compact(snapshot) {
        compactionDidStart();
        return snapshot.messages.slice(1).map((message) =>
          message.role === "tool"
            ? { ...message, content: [{ type: "json", value: { pruned: true } }] }
            : message
        );
      },
    }],
  });

  const run = await app.submit({ input: "use the large tool" });
  await assistantStarted;
  assert.equal(modelCall, 1, "the next step must wait for the assistant checkpoint");
  releaseAssistant();
  await compactionStarted;
  await run.result;

  const history = await app.history();
  const toolIndex = history.findIndex((event) => event.type === "tool.completed");
  const compactionIndex = history.findIndex((event) =>
    event.type === "context.compacted"
  );
  assert.ok(toolIndex >= 0);
  assert.ok(compactionIndex > toolIndex);

  let replayed;
  await Session.resume({
    id: app.sessionId,
    store,
    createRuntime(messages) {
      replayed = messages;
      return {};
    },
  });
  assert.equal(
    replayed.filter((message) =>
      message.role === "tool" && message.toolCallId === "large_1"
    ).length,
    1,
  );
  await app.close();
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
