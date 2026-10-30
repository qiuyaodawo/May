import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMayConfig } from "@sortedyuan/may/config";
import { InMemoryContext, May, runtimeHooks, withModelRequestRecording } from "@sortedyuan/may/core";
import { AgentApplication } from "@sortedyuan/may";
import { createModelContextSummarizer } from "@sortedyuan/may/context/model-summarizer";
import { Session } from "@sortedyuan/may/session";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";

test("真实模型请求保存、重新打开和分支保留完整请求", { timeout: 180_000 }, async () => {
  const config = await loadMayConfig();
  const selection = selectProviderModel(config, process.env.MAY_RECORDING_MODEL ? { model: process.env.MAY_RECORDING_MODEL } : {});
  const model = createBuiltinProviderModel(selection);
  const root = resolve(".test-output/request-recording");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/session-`);
  const store = new FileSessionStore(directory);
  let description = "Add two numbers when asked to calculate with add.";
  const tools = () => [{ name: "add", description, inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
    parse(input) { if (typeof input?.a !== "number" || typeof input?.b !== "number") throw new TypeError("Expected numeric a and b"); return input; },
    execute({ a, b }) { return a + b; } }];
  const runtime = (messages = []) => new May({ model, tools: tools(), maxSteps: 4, context: new InMemoryContext({ instructions: "Use the add tool whenever the user explicitly asks for it. Report its result.", messages }) });
  let session;
  try {
    session = await Session.create({ runtime: runtime(), store });
    const run = await session.submit({ input: "Call add with a=17 and b=25, then report the tool result.", signal: AbortSignal.timeout(90_000) });
    await run.result;
    const requests = await session.listModelRequests();
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(request => request.record.body === undefined));
    assert.ok(requests.every(request => request.status === "completed"));
    assert.ok(requests[0].record.request.messages.some(message => message.role === "system"));
    assert.equal(requests[0].record.request.tools[0].description, description);
    assert.ok((await session.history()).some(event => event.type === "tool.completed" && event.output === 42));
    assert.ok(requests.some(request => request.record.request.messages.some(message => message.role === "tool")));
    const original = requests[0];
    const key = selection.providerConfig.apiKey;
    if (typeof key === "string" && key.length > 0) assert.equal(JSON.stringify(requests).includes(key), false);
    await session.closeRuntime();
    description = "Compute the arithmetic sum of numeric inputs a and b.";
    session = await Session.resume({ id: session.id, store, providerBodyRecording: true, createRuntime: runtime });
    assert.deepEqual(await session.getModelRequest(original.modelCallId), requests.filter(request => request.modelCallId === original.modelCallId));
    const positions = await session.branchPositions();
    const fork = await Session.fork({ sourceId: session.id, positionSeq: positions.at(-1).positionSeq, store, requestRecording: "required", createRuntime: runtime });
    try { assert.deepEqual((await fork.listModelRequests()).map(request => request.record), requests.map(request => request.record)); }
    finally { await fork.closeRuntime(); }
    const definitionsBefore = (await session.history()).filter(event => event.type === "model.request.defined").length;
    const second = await session.submit({ input: "What is 3 + 4?", signal: AbortSignal.timeout(90_000) });
    await second.result;
    assert.ok((await session.listModelRequests()).at(-1).record.body);
    const history = await session.history();
    const definitions = history.filter(event => event.type === "model.request.defined");
    assert.equal(new Set(definitions.map(event => event.id)).size, definitions.length);
    assert.ok(definitions.length > definitionsBefore);
    assert.deepEqual((await session.getModelRequest(original.modelCallId))[0].record, original.record);
    assert.equal((await session.listModelRequests({ afterSeq: requests.at(-1).seq })).at(-1).record.request.tools[0].description, description);
    const summarizer = createModelContextSummarizer(withModelRequestRecording(model, session.recordModelRequest), { instructions: "Summarize briefly.", requestText: "Return a brief summary." });
    const summary = await summarizer.summarize({ messages: [{ role: "user", content: [{ type: "text", text: "The computed sum was 42." }] }], signal: AbortSignal.timeout(90_000) });
    assert.ok(summary.length > 0);
    assert.equal((await session.listModelRequests()).at(-1).record.purpose, "compaction");
  } finally {
    await session?.closeRuntime();
    await rm(directory, { recursive: true, force: true });
  }
});

test("真实应用保存 modelBefore 处理后的最终输入", { timeout: 120_000 }, async () => {
  const config = await loadMayConfig();
  const selection = selectProviderModel(config, process.env.MAY_RECORDING_MODEL ? { model: process.env.MAY_RECORDING_MODEL } : {});
  const root = resolve(".test-output/request-recording");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/application-`);
  const marker = "The model request includes the verified Hook instructions.";
  const app = await AgentApplication.open({ model: createBuiltinProviderModel(selection), store: new FileSessionStore(directory), providerBodyRecording: true, plugins: [{
    id: "verification.request-recording", version: "1.0.0", setup(ctx) {
      ctx.on(runtimeHooks.modelBefore, request => ({ ...request, messages: [...request.messages, { role: "user", content: [{ type: "text", text: marker }] }] }));
    },
  }] });
  try {
    const run = await app.submit({ input: "Respond with OK.", signal: AbortSignal.timeout(90_000) });
    await run.result;
    const [request] = await app.listModelRequests();
    assert.equal(request.status, "completed");
    assert.ok(JSON.stringify(request.record.request.messages).includes(marker));
    assert.ok(JSON.stringify(request.record.body).includes(marker));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
