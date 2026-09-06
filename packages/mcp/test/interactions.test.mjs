import assert from "node:assert/strict";
import test from "node:test";
import { openMcpClientPool, McpInteractionBroker } from "../dist/index.js";
import { startCatalogFixture } from "./fixtures/catalog-server.mjs";

const form = { mode: "form", message: "Review before sharing; never enter secrets", requestedSchema: {
  type: "object", properties: { name: { type: "string", minLength: 2 }, age: { type: "integer", minimum: 18 } }, required: ["name"],
} };
const context = (sessionId, signal = new AbortController().signal) => ({ scope: { workspaceId: "workspace", sessionId },
  runId: `run-${sessionId}`, toolCallId: `call-${sessionId}`, step: 1, idempotencyKey: sessionId, signal, report() {} });

test("MRTR preserves trusted owners and opaque state, validates responses and settles cancellation without replay", { timeout: 12_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  fixture.state.outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  fixture.state.input = (message) => {
    if (message.method !== "tools/call") return;
    if (!message.params.inputResponses) return { resultType: "input_required", requestState: " opaque\u0000state== ", inputRequests: {
      profile: { method: "elicitation/create", params: form },
    } };
    return { content: [{ type: "text", text: "done" }], structuredContent: { ok: true } };
  };
  const interactions = new McpInteractionBroker();
  const pool = await openMcpClientPool({ interactions, servers: [{ id: "remote", transport: "streamable-http", url: `${fixture.url}/modern` }] });
  t.after(() => pool.close());
  const notices = interactions.events[Symbol.asyncIterator]();
  const nextRequest = async () => { for (;;) { const event = (await notices.next()).value; if (event.type === "mcp.interaction.requested") return event.request; } };
  const cancel = new AbortController();
  const first = pool.tools[0].execute({ label: "one" }, context("one", cancel.signal));
  void first.catch(() => {});
  const a = await nextRequest();
  const second = pool.tools[0].execute({ label: "two" }, context("two"));
  const b = await nextRequest();
  assert.equal(a.owner.sessionId, "one"); assert.equal(b.owner.runId, "run-two");
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(interactions.respond(a.id, b.owner, { action: "accept", content: { name: "Alice" } }), false);
  assert.throws(() => interactions.respond(b.id, b.owner, { action: "accept", content: { name: "x" } }), /schema/);
  assert.throws(() => interactions.respond(b.id, b.owner, { action: "accept", content: { name: "Bob", extra: "secret" } }), /schema/);
  cancel.abort(); await assert.rejects(first);
  assert.equal(interactions.respond(a.id, a.owner, { action: "decline" }), false);
  assert.equal(interactions.respond(b.id, b.owner, { action: "accept", content: { name: "Bob", age: 21 } }), true);
  assert.deepEqual((await second).structuredContent, { ok: true });
  const calls = fixture.requests.filter((r) => r.message?.method === "tools/call").map((r) => r.message);
  assert.equal(calls.length, 3); assert.equal(new Set(calls.map((r) => r.id)).size, 3);
  assert.equal(calls[2].params.requestState, " opaque\u0000state== ");
  assert.deepEqual(calls[2].params.inputResponses, { profile: { action: "accept", content: { name: "Bob", age: 21 } } });
  assert.equal(JSON.stringify(calls).includes("workspace"), false);
  assert.equal(interactions.list(b.owner).length, 0);
});

test("resource/prompt interactions support URL consent, expiry and bounded state-only rounds; headless fails closed", { timeout: 12_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  const owner = { workspaceId: "workspace", sessionId: "session" };
  fixture.state.input = (m) => {
    if (!["resources/read", "prompts/get"].includes(m.method)) return;
    if (m.params.uri === "test:///loop") return { resultType: "input_required", requestState: "next" };
    if (!m.params.inputResponses) return { resultType: "input_required", requestState: "url-state", inputRequests: {
      url: { method: "elicitation/create", params: { mode: "url", message: "Authorize with the third-party website", url: "https://example.com/authorize?state=one" } },
    } };
  };
  const broker = new McpInteractionBroker();
  const pool = await openMcpClientPool({ interactions: broker, servers: [{ id: "remote", transport: "streamable-http", url: `${fixture.url}/modern`, maxTotalTimeoutMs: 1200 }] });
  t.after(() => pool.close());
  const notices = broker.events[Symbol.asyncIterator]();
  const next = async () => { for (;;) { const e = (await notices.next()).value; if (e.type === "mcp.interaction.requested") return e.request; } };
  const read = pool.readResource("remote", "test:///first", { owner });
  const r = await next(); assert.equal(r.params.mode, "url");
  assert.throws(() => broker.respond(r.id, owner, { action: "accept", content: { secret: "never" } }), /must not contain/);
  broker.respond(r.id, owner, { action: "accept" });
  assert.equal((await read).fromCache, false);
  const otherOwner = { ...owner, sessionId: "another-session" };
  const otherRead = pool.readResource("remote", "test:///first", { owner: otherOwner });
  const otherQuestion = await next(); broker.respond(otherQuestion.id, otherOwner, { action: "decline" });
  assert.equal((await otherRead).fromCache, false, "private resources do not reuse another Session's elicitation result");
  const prompt = pool.getPrompt("remote", "review", { file: "a" }, { owner });
  void prompt.catch(() => {}); const p = await next();
  await assert.rejects(prompt); assert.equal(broker.respond(p.id, owner, { action: "accept" }), false);
  await assert.rejects(pool.readResource("remote", "test:///loop", { owner }), /round|timeout/i);
  await assert.rejects(pool.readResource("remote", "test:///unowned"), /owner/);
  const pending = pool.readResource("remote", "test:///close", { owner }); void pending.catch(() => {});
  await next(); await pool.close(); await assert.rejects(pending); assert.equal(broker.list(owner).length, 0);
  const headless = await openMcpClientPool({ servers: [{ id: "no-ui", transport: "streamable-http", url: `${fixture.url}/modern` }] });
  t.after(() => headless.close()); await assert.rejects(headless.getPrompt("no-ui", "review", { file: "a" }, { owner }));
});
