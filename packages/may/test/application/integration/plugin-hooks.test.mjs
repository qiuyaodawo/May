import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { AgentApplication, applicationHooks } from "@sortedyuan/may";
import { runtimeHooks, userMessage } from "@sortedyuan/may/core";
import { InMemorySessionStore } from "@sortedyuan/may/session";

import { createModel, documentPath } from "../fixtures/live-model.mjs";

const packagePath = new URL("../../../../../package.json", import.meta.url);

test(
  "a plugin continuation is committed before the next model request and restored without adding user input",
  { timeout: 120_000 },
  async (t) => {
    const store = new InMemorySessionStore();
    const plugin = {
      id: "verification.continuation",
      version: "1.0.0",
      state: { version: 1, initial: { continued: false } },
      setup(ctx) {
        ctx.on(runtimeHooks.runBeforeEnd, async (value) => {
          if (ctx.state.get().continued) return;
          await ctx.state.set({ continued: true });
          return {
            ...value,
            continueMessages: [userMessage("Reply with exactly CONTINUED_BY_PLUGIN.")],
            reason: "The configured delivery condition requires another response.",
          };
        });
      },
    };
    const model = await createModel();
    const app = await AgentApplication.open({ model, store, permissionPolicy: () => "deny", plugins: [plugin] });
    t.after(() => app.close());
    const result = await (await app.submit({ input: "Reply with exactly READY_FOR_PLUGIN." })).result;
    assert.equal(result.modelCalls, 2);
    const history = await app.history();
    const generatedIndex = history.findIndex((event) => event.type === "input.generated");
    const secondModelIndex = history.findIndex((event) => event.type === "assistant.completed" && event.step === 2);
    assert.ok(generatedIndex >= 0 && generatedIndex < secondModelIndex);
    assert.equal(history.filter((event) => event.type === "input.submitted").length, 1);
    const sessionId = app.sessionId;
    await app.close();
    const resumed = await AgentApplication.open({
      model,
      store,
      permissionPolicy: () => "deny",
      plugins: [plugin],
      sessionId,
      resume: true,
    });
    t.after(() => resumed.close());
    assert.equal((await (await resumed.continue()).result).modelCalls, 1);
    const current = await resumed.history();
    assert.equal(current.filter((event) => event.type === "input.generated").length, 1);
    assert.equal(current.filter((event) => event.type === "input.submitted").length, 1);
  },
);

test(
  "approval Hook failure stops actual file access and remains visible in durable history",
  { timeout: 120_000 },
  async (t) => {
    let reads = 0;
    const plugin = {
      id: "verification.approval-failure",
      version: "1.0.0",
      setup(ctx) {
        ctx.on(applicationHooks.approvalRequested, (event) => {
          assert.equal(event.request.context.report, undefined);
          throw new Error("Approval extension rejected the request");
        });
      },
    };
    const app = await AgentApplication.open({
      model: await createModel(),
      store: new InMemorySessionStore(),
      permissionPolicy: () => "ask",
      plugins: [plugin],
      instructions: "Call read_document exactly once before answering. You must use the tool to obtain its contents.",
      tools: [
        {
          name: "read_document",
          description: "Read the actual project README",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            reads += 1;
            return (await readFile(documentPath, "utf8")).slice(0, 256);
          },
        },
      ],
    });
    t.after(() => app.close());
    await assert.rejects(
      (await app.submit({ input: "Use read_document and tell me the project name." })).result,
      /Approval extension rejected/,
    );
    assert.equal(reads, 0);
    const history = await app.history();
    assert.ok(history.some((event) => event.type === "approval.requested"));
    assert.ok(history.some((event) => event.type === "run.failed"));
  },
);

test(
  "observation isolation reports failures and input submission completes before the real model request",
  { timeout: 120_000 },
  async (t) => {
    const reports = [];
    const plugin = {
      id: "verification.observation",
      version: "1.0.0",
      setup(ctx) {
        let committed = false;
        ctx.on(applicationHooks.inputSubmitted, async (value, context) => {
          await setTimeout(25, undefined, { signal: context.signal });
          committed = true;
        });
        ctx.on(runtimeHooks.modelBefore, () => {
          assert.equal(committed, true);
        });
        ctx.on(
          runtimeHooks.modelAfter,
          () => {
            throw new Error("Observation delivery failed");
          },
          { failure: "isolate" },
        );
      },
    };
    const model = await createModel();
    const app = await AgentApplication.open({
      model,
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [plugin],
      onPluginHookError: (error, hook, pluginId) => {
        reports.push({ error: error.message, hook: hook.name, pluginId });
      },
    });
    t.after(() => app.close());
    assert.equal((await (await app.submit({ input: "Reply with exactly OBSERVED." })).result).modelCalls, 1);
    assert.deepEqual(reports, [{ error: "Observation delivery failed", hook: "model.after", pluginId: plugin.id }]);
    const failing = await AgentApplication.open({
      model,
      store: new InMemorySessionStore(),
      permissionPolicy: () => "deny",
      plugins: [plugin],
      onPluginHookError: () => {
        throw new Error("Observation reporter failed");
      },
    });
    t.after(() => failing.close());
    await assert.rejects(
      (await failing.submit({ input: "Reply with exactly REPORTER." })).result,
      /Observation reporter failed/,
    );
    assert.ok((await failing.history()).some((event) => event.type === "run.failed"));
  },
);

test(
  "real tool input transforms precede authorization and durable results preserve actual output and transformed content",
  { timeout: 120_000 },
  async (t) => {
    const store = new InMemorySessionStore();
    const parsed = [];
    const authorized = [];
    let reads = 0;
    let modelEvents = 0;
    let progress = 0;
    let app;
    const plugin = {
      id: "verification.tool-transform",
      version: "1.0.0",
      setup(ctx) {
        ctx.on(runtimeHooks.toolBefore, (value) => ({ ...value, input: { path: "package.json" } }));
        ctx.on(runtimeHooks.toolResult, (value) => ({
          ...value,
          content: [{ type: "text", text: "Projected result: package.json was read successfully." }],
        }));
        ctx.on(runtimeHooks.modelEvent, (value, context) => {
          assert.ok(context.signal instanceof AbortSignal);
          modelEvents += 1;
        });
        ctx.on(runtimeHooks.toolProgress, (value, context) => {
          assert.ok(context.signal instanceof AbortSignal);
          progress += 1;
        });
        ctx.on(runtimeHooks.toolAfter, async (value) => {
          const saved = (await app.history()).find(
            (event) => event.type === "tool.completed" && event.call.id === value.call.id,
          );
          assert.equal(saved.output.contents, await readFile(packagePath, "utf8"));
        });
      },
    };
    const tools = [
      {
        name: "read_document",
        description: "Read README.md or package.json from this project",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", enum: ["README.md", "package.json"] } },
          required: ["path"],
          additionalProperties: false,
        },
        parse(input) {
          if (
            typeof input !== "object" ||
            input === null ||
            Array.isArray(input) ||
            (input.path !== "README.md" && input.path !== "package.json")
          )
            throw new TypeError("Unsupported document path");
          parsed.push(input.path);
          return { path: input.path };
        },
        async execute(input, context) {
          assert.ok(Object.isFrozen(input));
          reads += 1;
          context.report({ type: "progress", message: `Reading ${input.path}` });
          return {
            filename: input.path,
            contents: await readFile(input.path === "package.json" ? packagePath : documentPath, "utf8"),
          };
        },
      },
    ];
    const model = await createModel();
    app = await AgentApplication.open({
      model,
      store,
      plugins: [plugin],
      tools,
      instructions:
        "Call read_document with path README.md exactly once. After its response, answer DONE and do not call any tool again.",
      permissionPolicy: (check) => {
        authorized.push(structuredClone(check.input));
        return "allow";
      },
    });
    t.after(() => app.close());
    await (
      await app.submit({ input: "Read README.md using read_document, then answer DONE." })
    ).result;
    assert.equal(reads, 1);
    assert.deepEqual(parsed, ["package.json"]);
    assert.deepEqual(authorized, [{ path: "package.json" }]);
    assert.ok(modelEvents > 0 && progress > 0);
    const saved = (await app.history()).find((event) => event.type === "tool.completed");
    const started = (await app.history()).find((event) => event.type === "tool.started");
    assert.equal(started.input.path, "package.json");
    assert.equal(saved.output.contents, await readFile(packagePath, "utf8"));
    assert.deepEqual(saved.content, [{ type: "text", text: "Projected result: package.json was read successfully." }]);
    const sessionId = app.sessionId;
    await app.close();
    const resumed = await AgentApplication.open({
      model,
      store,
      plugins: [plugin],
      tools,
      permissionPolicy: () => "deny",
      sessionId,
      resume: true,
    });
    t.after(() => resumed.close());
    assert.equal(reads, 1);
    assert.equal((await resumed.inspectContext()).messageCount, 4);
  },
);
