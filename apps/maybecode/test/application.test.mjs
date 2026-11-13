import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestWorkspace as temporaryDirectory } from "./fixtures/workspace.mjs";
import { assistantMessage, collectEvents } from "./fixtures/application.mjs";

import { InMemoryContext, RunCancelledError } from "@sortedyuan/may/core";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { InMemorySessionCatalog } from "@sortedyuan/may/session/catalog";
import { TranscriptStore } from "@sortedyuan/tui/transcript";
import { readCodingToolPresentation } from "@sortedyuan/tui/tool-renderers";
import { MaybeCodeWorkspace } from "../dist/workspace.js";

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
            toolCalls: [
              {
                id: `write_${modelCall}`,
                name: "write",
                input: {
                  path: "result.txt",
                  content: modelCall === 1 ? "first" : "second",
                },
              },
            ],
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
    git: false,
    requestRecording: "off",
    workspace,
    subagents: false,
    model,
    store: new FileSessionStore(sessionDirectory),
    catalog,
    autoResume: false,
  });
  const sessionId = app.sessionId;
  const eventReader = collectEvents(app, events, "allow-session");

  assert.equal((await (await app.submit({ input: "create result" })).result).message.content[0].text, "created");
  assert.equal((await (await app.submit({ input: "update result" })).result).message.content[0].text, "updated");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "second");

  const history = await app.history();
  assert.equal(history.filter((event) => event.type === "approval.requested").length, 1);
  assert.ok(
    history.findIndex((event) => event.type === "approval.resolved") <
      history.findIndex((event) => event.type === "tool.completed"),
  );
  const persistedPreviews = history.filter((event) => event.type === "tool.presentation");
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
    events.filter((event) => event.type === "permission.event" && event.event.type === "approval.requested").length,
    1,
  );
  const previews = events.filter((event) => event.type === "change.preview");
  assert.deepEqual(
    previews.map((event) => event.preview.status === "ready" && event.preview.kind),
    ["create", "update"],
  );

  const resumed = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace,
    subagents: false,
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
      .map((item) => readCodingToolPresentation(item)?.preview.kind),
    ["create", "update"],
  );
  await resumed.close();
});

test("retries a failed run after resuming its durable session", async (t) => {
  const workspace = await temporaryDirectory(t);
  const store = new FileSessionStore(join(workspace, ".sessions"));
  const catalog = new InMemorySessionCatalog();
  const first = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
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
  await assert.rejects((await first.submit({ input: "keep this request" })).result, /provider offline/);
  await first.close();

  let request;
  const resumed = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
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
  await (
    await resumed.retry()
  ).result;
  assert.equal(request.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(request.messages.find((message) => message.role === "user").content[0].text, "keep this request");
  assert.equal((await resumed.history()).filter((event) => event.type === "input.submitted").length, 1);
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
        message: call === undefined ? assistantMessage("done") : { role: "assistant", content: [], toolCalls: [call] },
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace,
    model,
    store: new (await import("@sortedyuan/may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    subagents: false,
  });
  const events = [];
  const eventReader = collectEvents(app, events, "allow");

  await (
    await app.submit({ input: "use every tool" })
  ).result;
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "new");
  await app.close();
  await eventReader;

  const completed = events
    .filter((event) => event.type === "run.event" && event.event.type === "tool.completed")
    .map((event) => event.event);
  assert.deepEqual(
    completed.map((event) => event.call.name),
    ["read", "write", "edit", "shell"],
  );
  assert.equal(completed[3].output.stdout, "verified");
  const shellDefinition = firstRequest.tools.find((tool) => tool.name === "shell");
  assert.match(
    shellDefinition.inputSchema.properties.command.description,
    process.platform === "win32" ? /PowerShell/u : /Bash/u,
  );
  assert.match(
    firstRequest.messages[0].content[0].text,
    process.platform === "win32" ? /Shell: (?:Windows PowerShell|PowerShell 7)/u : /Shell: Bash/u,
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
            toolCalls: [
              {
                id: "history_1",
                name: "session_history",
                input: { order: "desc", limit: 5 },
              },
            ],
          },
        };
        return;
      }
      historyOutput = request.messages.find((message) => message.role === "tool" && message.name === "session_history")
        ?.content[0]?.value;
      yield {
        type: "response.completed",
        message: assistantMessage("history inspected"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    git: false,
    requestRecording: "off",
    workspace: process.cwd(),
    model,
    store: new (await import("@sortedyuan/may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    subagents: false,
  });

  await (
    await app.submit({ input: "inspect this session" })
  ).result;

  assert.ok(Array.isArray(historyOutput.events));
  assert.ok(historyOutput.events.some((event) => event.type === "input.submitted"));
  assert.equal(
    (await app.history()).some((event) => event.type === "approval.requested"),
    false,
  );
  await app.close();
});

test("starts fresh by default and explicitly resumes workspace sessions", async () => {
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
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

  const first = await MaybeCodeWorkspace.open({ ...options, git: false, requestRecording: "off", autoResume: false });
  const firstId = first.sessionId;
  await (
    await first.submit({ input: "first" })
  ).result;
  await first.close();

  const resumed = await MaybeCodeWorkspace.open({ ...options, git: false, requestRecording: "off", autoResume: true });
  assert.equal(resumed.sessionId, firstId);
  const inspection = await resumed.inspectContext();
  assert.equal(inspection.measurementMethod, "estimated");
  assert.equal(inspection.measuredInputTokens, undefined);
  assert.ok(inspection.effectiveTokens > 100);
  assert.equal(inspection.contextWindowTokens, 10000);
  await (
    await resumed.submit({ input: "second" })
  ).result;
  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );

  const secondId = await resumed.newSession();
  assert.notEqual(secondId, firstId);
  assert.equal((await resumed.listSessions()).length, 2);
  await resumed.resumeSession(firstId);
  assert.equal(resumed.sessionId, firstId);
  await resumed.close();

  const fresh = await MaybeCodeWorkspace.open({ ...options, git: false, requestRecording: "off" });
  assert.notEqual(fresh.sessionId, firstId);
  await fresh.close();
});

test("creates context through an injected factory for each session", async () => {
  const store = new (await import("@sortedyuan/may/session")).InMemorySessionStore();
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
    git: false,
    requestRecording: "off",
    workspace: process.cwd(),
    model,
    store,
    catalog,
    contextFactory,
    autoResume: false,
  });

  const firstId = app.sessionId;
  await (
    await app.submit({ input: "first" })
  ).result;
  await app.newSession();
  await app.resumeSession(firstId);

  assert.equal(inputs.length, 3);
  assert.equal(new Set(contexts).size, 3);
  assert.deepEqual(
    inputs.map((input) => input.messages?.length ?? 0),
    [0, 0, 2],
  );
  assert.match(inputs[0].instructions, /Session origin: new session/u);
  assert.match(inputs[2].instructions, /Session origin: resumed session/u);
  assert.equal(
    inputs[0].instructions.replace("Session origin: new session", "Session origin: resumed session"),
    inputs[2].instructions,
  );
  assert.deepEqual(inputs[0].metadata, { workspace: process.cwd() });
  assert.equal(await app.inspectContext(), undefined);
  await assert.rejects(app.compactContext(), /compaction is not supported/u);
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
    git: false,
    requestRecording: "off",
    workspace: process.cwd(),
    model,
    store: new (await import("@sortedyuan/may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  const run = await app.submit({ input: "wait" });
  await modelStarted;
  await assert.rejects(app.compactContext(), /while an operation is active/u);
  assert.equal(app.cancel("stop"), true);
  await assert.rejects(run.result, RunCancelledError);
  assert.equal(app.application.getDelegationState().status, "cancelled");
  assert.equal(app.application.getDelegationState().budget.usageComplete, false);
  await app.close();
});
