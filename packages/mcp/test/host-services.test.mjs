import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpInteractionBroker, openMcpClientPool, createMcpModelSampler, validateMcpServerOptions } from "../dist/index.js";
import { startCatalogFixture } from "./fixtures/catalog-server.mjs";
import { startLegacyHostHttp } from "./fixtures/legacy-host-http.mjs";

const formAnswer = { action: "accept", content: { value: "reviewed" } };
const context = (workspaceId, sessionId, signal = new AbortController().signal) => ({ scope: { workspaceId, sessionId },
  runId: `run-${sessionId}`, toolCallId: `call-${sessionId}`, step: 1, idempotencyKey: sessionId, signal, report() {} });
const nextRequest = (broker) => {
  const events = broker.events[Symbol.asyncIterator]();
  return async () => { for (;;) { const event = (await events.next()).value; if (event.type === "mcp.interaction.requested" && broker.list(event.request.owner).some((r) => r.id === event.request.id)) return event.request; } };
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "may-mcp-host-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const sampleParams = { messages: [{ role: "user", content: { type: "text", text: "remote input" } }], maxTokens: 32 };

test("Roots and Sampling require scoped consent, isolate model inputs, review outputs, and enforce budgets", { timeout: 15_000 }, async (t) => {
  const path = await directory(t);
  const fixture = await startCatalogFixture(t);
  let params = sampleParams;
  let repeatSampling = false;
  let rootUri = pathToFileURL(path).href;
  let holdModel = false;
  let releaseModel;
  let modelStarted;
  let started;
  fixture.state.input = (m) => {
    if (m.method !== "tools/call") return;
    if (!m.params.inputResponses || repeatSampling) return { resultType: "input_required", requestState: "owned", inputRequests: { input: m.params.arguments.kind === "roots"
      ? { method: "roots/list" } : { method: "sampling/createMessage", params } } };
    return { content: [{ type: "text", text: JSON.stringify(m.params.inputResponses.input) }] };
  };
  const broker = new McpInteractionBroker(); const next = nextRequest(broker);
  const modelInputs = [];
  const sampling = createMcpModelSampler((maxTokens) => ({ name: "host-model", model: { limits: { maxOutputTokens: maxTokens }, async *stream(request) {
    modelInputs.push(request);
    if (holdModel) { modelStarted(); await new Promise((resolve) => releaseModel = resolve); }
    yield { type: "response.completed", usage: { outputTokens: 8 }, message: { role: "assistant", content: [{ type: "text", text: "generated private answer" }], modelState: { type: "hidden", data: "must not leave" } } };
  } } }));
  const pool = await openMcpClientPool({ interactions: broker, hostServices: { roots: async () => [{ uri: rootUri }], sampling },
    servers: [{ id: "remote", transport: "streamable-http", url: fixture.url + "/modern", host: { roots: true, sampling: true } }] });
  t.after(() => pool.close());
  const execute = (kind, signal) => pool.tools[0].execute({ kind }, context(path, "A", signal));
  const roots = execute("roots");
  const r = await next(); assert.equal(r.params.kind, "roots"); assert.equal(r.params.editable, false);
  assert.equal(JSON.stringify(fixture.requests).includes(pathToFileURL(path).href), false);
  assert.throws(() => broker.respond(r.id, r.owner, { action: "accept", content: { json: "[]" } }), /editable/);
  broker.respond(r.id, r.owner, { action: "accept" });
  assert.deepEqual(JSON.parse((await roots).content[0].text).roots, [{ uri: pathToFileURL(await realpath(path)).href }]);
  const denied = execute("roots"); const d = await next(); broker.respond(d.id, d.owner, { action: "decline" });
  assert.deepEqual(JSON.parse((await denied).content[0].text), { roots: [] });

  const withheld = execute("sample"); void withheld.catch(() => {});
  const input = await next(); assert.equal(input.params.kind, "sampling.request"); assert.equal(modelInputs.length, 0);
  const editedInput = { ...sampleParams, messages: [{ role: "user", content: { type: "text", text: "user edited input" } }] };
  broker.respond(input.id, input.owner, { action: "accept", content: { json: JSON.stringify(editedInput) } });
  const output = await next(); assert.equal(output.params.kind, "sampling.response");
  assert.equal(modelInputs[0].messages[0].content[0].text, "user edited input"); assert.deepEqual(modelInputs[0].tools, []);
  broker.respond(output.id, output.owner, { action: "decline" }); await assert.rejects(withheld, /withheld/);
  assert.equal(JSON.stringify(fixture.requests).includes("generated private answer"), false);
  assert.equal(JSON.stringify(fixture.requests).includes("must not leave"), false);

  const accepted = execute("sample"); const a = await next(); broker.respond(a.id, a.owner, { action: "accept" });
  const b = await next(); broker.respond(b.id, b.owner, { action: "accept", content: { json: JSON.stringify({ ...b.params.data, content: { type: "text", text: "reviewed response" } }) } });
  assert.equal(JSON.parse((await accepted).content[0].text).content.text, "reviewed response");
  params = { ...sampleParams, includeContext: "allServers" }; await assert.rejects(execute("sample"), /Context/);
  params = { ...sampleParams, maxTokens: 5000 }; await assert.rejects(execute("sample"), /limit/);
  assert.equal(modelInputs.length, 2);
  params = sampleParams; repeatSampling = true;
  const loop = execute("sample"); void loop.catch(() => {});
  for (let i = 0; i < 4; i++) {
    const input = await next(); broker.respond(input.id, input.owner, { action: "accept" });
    const output = await next(); broker.respond(output.id, output.owner, { action: "accept" });
  }
  await assert.rejects(loop, /four calls/); assert.equal(modelInputs.length, 6);
  repeatSampling = false; holdModel = true;
  started = new Promise((resolve) => modelStarted = resolve);
  const cancellation = new AbortController();
  const waiting = execute("sample", cancellation.signal); void waiting.catch(() => {});
  const pending = await next(); broker.respond(pending.id, pending.owner, { action: "accept" });
  await started; cancellation.abort(); await assert.rejects(waiting);
  assert.equal(broker.list(pending.owner).length, 0);
  releaseModel(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.list(pending.owner).length, 0, "late model output is never offered after cancellation");
  rootUri = pathToFileURL(join(path, "sensitive-private-root")).href;
  await assert.rejects(execute("roots"), (error) => !error.message.includes("sensitive-private-root"));

  const discover = fixture.requests.find((r) => r.message?.method === "server/discover").message;
  assert.deepEqual(discover.params._meta["io.modelcontextprotocol/clientCapabilities"].sampling, { tools: {} });
  assert.throws(() => validateMcpServerOptions({ id: "bad", command: "node", host: { roots: "yes" } }), /host/);
});

test("sampling tool proposals are never executed; history/media and provider budgets stay isolated", async () => {
  let request;
  const sampler = createMcpModelSampler((maxTokens) => ({ name: "bounded-model", model: { limits: { maxOutputTokens: maxTokens }, async *stream(value) {
    request = value;
    yield { type: "response.completed", message: { role: "assistant", content: [], toolCalls: [{ id: "new", name: "remote_tool", input: { value: 2 } }] } };
  } } }));
  const ctx = { serverId: "remote", requestId: "logical", owner: { workspaceId: "host", sessionId: "session" }, signal: new AbortController().signal, expiresAt: Date.now() + 10_000 };
  const params = { maxTokens: 32, toolChoice: { mode: "required" }, systemPrompt: "Reviewed server sampler instructions",
    tools: [{ name: "remote_tool", inputSchema: { type: "object" } }], messages: [
      { role: "assistant", content: { type: "tool_use", name: "remote_tool", id: "old", input: { value: 1 } } },
      { role: "user", content: [{ type: "tool_result", toolUseId: "old", content: [{ type: "text", text: "one" }] }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
    ] };
  const result = await sampler.createMessage(params, ctx);
  assert.equal(result.content[0].type, "tool_use"); assert.equal(result.stopReason, "toolUse");
  assert.equal(request.messages[0].role, "system"); assert.equal(request.messages[2].role, "tool"); assert.equal(request.messages[3].content[0].type, "image");
  assert.deepEqual(request.tools.map((tool) => tool.name), ["remote_tool"]);
  await assert.rejects(sampler.createMessage({ ...params, toolChoice: { mode: "none" } }, ctx), /undeclared/);
  const unbounded = createMcpModelSampler(() => ({ name: "bad", model: { stream() { assert.fail("unbounded provider must not run"); } } }));
  await assert.rejects(unbounded.createMessage(sampleParams, ctx), /token/);
});

test("isolated legacy stdio/HTTP requests own exactly one operation, reject unsolicited access and clean up", { timeout: 20_000 }, async (t) => {
  const path = await directory(t);
  const http = await startLegacyHostHttp(t);
  for (const transport of ["stdio", "streamable-http"]) {
    const broker = new McpInteractionBroker(); const next = nextRequest(broker);
    let samples = 0;
    const server = { id: "legacy", protocolMode: "legacy", host: { legacyRequests: "isolated", roots: true, sampling: true },
      ...(transport === "stdio" ? { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/legacy-host-peer.mjs", import.meta.url)), "--stdio"] }
        : { transport, url: http.url }),
    };
    const pool = await openMcpClientPool({ servers: [server], interactions: broker, hostServices: {
      roots: async () => [{ uri: pathToFileURL(path).href }], sampling: { async createMessage(_params, scope) {
        samples++; return { role: "assistant", model: "isolated", content: { type: "text", text: scope.owner.sessionId } };
      } },
    } });
    t.after(() => pool.close());
    assert.equal(samples, 0);
    const invoke = (session, args, signal) => pool.tools[0].execute(args, context(path, session, signal));
    const chain = invoke("A", { label: "A" });
    for (const kind of ["roots", "form", "url", "sampling.request", "sampling.response"]) {
      const question = await next(); assert.equal(question.owner.sessionId, "A"); assert.equal(question.params.kind ?? question.params.mode, kind);
      broker.respond(question.id, question.owner, kind === "form" ? formAnswer : { action: "accept" });
    }
    const result = JSON.parse((await chain).content[0].text);
    assert.equal(result.generated.content.text, "A"); assert.equal(samples, 1);
    assert.deepEqual(result.startup[0], { roots: [] }); assert.ok(result.startup[1].error);
    if (transport === "stdio") assert.throws(() => process.kill(result.pid, 0));
    const abort = new AbortController();
    const first = invoke("B", { mode: "form", label: "B" }, abort.signal); void first.catch(() => {});
    const b = await next();
    const second = invoke("C", { mode: "form", label: "C" }); const c = await next();
    assert.notEqual(b.requestId, c.requestId); assert.equal(broker.respond(b.id, c.owner, formAnswer), false);
    abort.abort(); await assert.rejects(first);
    broker.respond(c.id, c.owner, formAnswer); const cResult = JSON.parse((await second).content[0].text);
    assert.equal(cResult.input.content.value, "reviewed");
    if (transport === "stdio") assert.throws(() => process.kill(cResult.pid, 0));
    const read = pool.readResource("legacy", "test:///value", { owner: { workspaceId: path, sessionId: "resource" } });
    const r = await next(); assert.equal(r.owner.sessionId, "resource"); broker.respond(r.id, r.owner, formAnswer);
    assert.match((await read).result.contents[0].text, /reviewed/);
    const prompt = pool.getPrompt("legacy", "review", {}, { owner: { workspaceId: path, sessionId: "prompt" } });
    const p = await next(); broker.respond(p.id, p.owner, formAnswer); assert.equal((await prompt).result.messages.length, 1);
    await invoke("early", { mode: "early" });
    assert.equal(broker.list({ workspaceId: path, sessionId: "early" }).length, 0);
    const closing = invoke("close", { mode: "form" }); void closing.catch(() => {}); await next();
    await pool.close(); await assert.rejects(closing);
    assert.equal(broker.list({ workspaceId: path, sessionId: "close" }).length, 0);
  }
  const sessionsWithCalls = http.requests.filter((r) => ["tools/call", "resources/read", "prompts/get"].includes(r.message?.method)).map((r) => r.id);
  assert.equal(new Set(sessionsWithCalls).size, sessionsWithCalls.length, "legacy HTTP sessions never serve two logical operations");
  assert.ok([...http.sessions.values()].every((session) => session.closed));
});
