import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentWorkspace, defineAgent } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "../dist/application.js";
import { startUiServer } from "../dist/server.js";
import { UiClient } from "../dist/index.js";
import { UiProjection } from "../dist/projection.js";

const token = "fixture-only-token-0123456789abcdef";
async function until(probe) { for (let i = 0; i < 100; i++) { const value = await probe(); if (value) return value; await delay(20); } throw new Error("Timed out"); }

test("shared host authenticates, deduplicates commands, restores approvals and survives a client disconnect", async t => {
  let calls = 0, toolCalls = 0;
  const store = new InMemorySessionStore();
  const definition = defineAgent({
    model: { async *stream() {
      calls++;
      if (calls === 1) yield { type: "response.completed", message: { role: "assistant", content: [], toolCalls: [{ id: "check-1", name: "check", input: {} }] } };
      else {
        yield { type: "text.delta", delta: "Hello" };
        yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: "Hello <script>not HTML</script>" }], modelState: { type: "private", data: { secret: "NEVER_TRANSMIT" } } } };
      }
    } },
    tools: [{ name: "check", description: "Fixture", inputSchema: { type: "object", properties: {} }, execute: () => { toolCalls++; return "checked"; } }],
    permissionPolicy: () => "ask", sessionHistory: false,
  });
  const app = await AgentWorkspace.open({ workspace: "fixture", store, catalog: new InMemorySessionCatalog(), openApplication: selection => definition.open({ ...selection, store }) });
  const host = new ApplicationUiHost(app, { product: { id: "fixture", title: "Fixture", subtitle: "Fixture", resourceKind: "session", suggestions: [] } });
  const server = await startUiServer({ host, token, port: 0, assets: new Map(), close: () => host.close() });
  t.after(() => server.close());
  const request = (path, body, headers = {}) => fetch(server.url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(server.url + "/api/ui/snapshot")).status, 401);
  assert.equal((await request("/api/ui/snapshot", undefined, { origin: "https://attacker.invalid" })).status, 403);
  const initial = await (await request("/api/ui/snapshot")).json();
  const command = { version: 1, hostId: initial.hostId, requestId: "submit-1", name: "message.submit", targetId: initial.selectedId, args: { text: "Check" } };
  const clients = [new UiClient(server.url), new UiClient(server.url)];
  t.after(() => clients.forEach(c => c.disconnect()));
  await Promise.all(clients.map(c => c.connect(token)));
  const submitted = await Promise.all([request("/api/ui/commands", command), request("/api/ui/commands", command)]);
  assert.ok(submitted.every(r => r.status === 200));
  clients[0].disconnect();
  assert.equal((await request("/api/ui/commands", { ...command, args: { text: "changed" } })).status, 409);
  const pending = await until(async () => { const s = await (await request("/api/ui/snapshot")).json(); return s.interactions.length ? s : undefined; });
  assert.equal(toolCalls, 0); assert.equal(app.isRunning, true);
  assert.equal(pending.blocks.find(b => b.kind === "tool").status, "awaiting-approval");
  const unavailable = { ...command, requestId: "unavailable-choice", name: "approval.resolve", args: { id: pending.interactions[0].id, decision: "allow-session" } };
  assert.equal((await request("/api/ui/commands", unavailable)).status, 409);
  await clients[1].refresh();
  assert.equal(clients[1].state.snapshot.interactions[0].id, pending.interactions[0].id);
  const approval = { ...command, requestId: "approve-1", name: "approval.resolve", args: { id: pending.interactions[0].id, decision: "allow" } };
  assert.equal((await request("/api/ui/commands", approval)).status, 200);
  await until(() => !app.isRunning);
  const finished = await (await request("/api/ui/snapshot")).json();
  assert.equal(toolCalls, 1); assert.equal(calls, 2); assert.equal(finished.interactions.length, 0);
  assert.equal(finished.blocks.find(b => b.kind === "tool").approval.status, "allowed");
  assert.equal(finished.blocks.find(b => b.kind === "tool").status, "completed");
  assert.equal(finished.blocks.filter(b => b.kind === "user").length, 1);
  assert.ok(finished.blocks.filter(b => b.kind === "assistant").every(b => b.text || b.reasoning), "tool-only responses must not render empty assistant bubbles");
  assert.ok(finished.blocks.some(b => b.text.includes("<script>")));
  assert.ok(!JSON.stringify(finished).includes("NEVER_TRANSMIT"));
  assert.equal((await request("/api/ui/commands", { ...approval, requestId: "approve-stale" })).status, 409);
  assert.equal((await request("/api/ui/commands", { ...command, requestId: "old-host", hostId: "old" })).status, 409);
  await request("/api/ui/commands", { ...command, requestId: "new-session", name: "session.new", expectedActiveId: finished.activeId, args: {} });
  assert.equal((await request("/api/ui/commands", { ...command, requestId: "old-session" })).status, 409);
});

test("client preserves the browser fetch receiver, ignores stale selections and never retries mutations", async t => {
  const snapshot = id => ({ version: 1, hostId: "host", revision: 1, selectedId: id, product: { id: "fixture" }, blocks: [], resources: [], commands: [] });
  let resolveOld, resolveRead, posts = 0;
  const request = async function (url, init) {
    assert.equal(this, globalThis, "browser fetch requires the Window receiver");
    if (init.method === "POST") { posts++; throw new Error("Response lost"); }
    if (url.includes("events")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    if (url.includes("/api/ui/history")) return new Promise(resolve => { resolveRead = () => resolve(Response.json({ hostId: "host", items: [], nextCursor: null, total: 0 })); });
    if (url.includes("selected=old")) return new Promise(resolve => { resolveOld = () => resolve(Response.json(snapshot("old"))); });
    if (url.includes("selected=missing")) return Response.json({ error: "Unknown session" }, { status: 404 });
    return Response.json(snapshot(url.includes("selected=new") ? "new" : null));
  };
  t.mock.method(globalThis, "fetch", request);
  const client = new UiClient();
  t.after(() => client.disconnect());
  await client.connect(token);
  const old = client.select("old");
  await assert.rejects(client.command("message.submit", { text: "during selection" })); assert.equal(posts, 0);
  await client.select("new"); resolveOld(); await old;
  assert.equal(client.state.snapshot.selectedId, "new");
  const staleRead = client.readHistory();
  const rejectedRead = assert.rejects(staleRead, /浏览对象已改变/);
  await client.select("new"); resolveRead(); await rejectedRead;
  await assert.rejects(client.select("missing")); await client.refresh();
  assert.equal(client.state.snapshot.selectedId, "new"); assert.equal(client.state.selecting, false);
  await assert.rejects(client.command("message.submit", { text: "hi" }), /Response lost/);
  assert.equal(posts, 1); assert.match(client.state.error, /未自动重发/); client.disconnect();
});

test("projection separates approval evidence, terminal outcomes and unknown effects", () => {
  const projection = new UiProjection();
  const call = { id: "call", name: "fixture", input: { text: "<script>text only</script>" } };
  const event = (type, rest = {}) => ({ type, runId: "run", step: 1, seq: 1, timestamp: 1, ...rest });
  const run = (type, rest) => projection.event({ type: "run.event", event: event(type, rest) });
  const request = { id: "approval", tool: { name: "fixture" }, input: call.input, context: { runId: "run", step: 1, toolCallId: "call" }, createdAt: 1 };
  const permission = (type, rest) => projection.event({ type: "permission.event", event: event(type, rest) });
  run("tool.started", { call });
  permission("approval.requested", { request });
  assert.equal(projection.blocks.get("tool:run:call").status, "awaiting-approval");
  assert.equal(projection.interactions.get("approval").blockId, "tool:run:call");
  const history = new UiProjection();
  history.history([event("tool.started", { call }), event("approval.requested", { request: { ...request, ...request.context } })]);
  assert.equal(history.interactions.size, 0, "historical request must not become an action");
  history.settle(); assert.equal(history.blocks.get("tool:run:call").status, "unknown");
  permission("approval.cancelled", { requestId: "approval" });
  run("tool.failed", { call, error: { message: "Cancelled", code: "RUN_CANCELLED" } });
  run("run.cancelled", { reason: "Cancelled by operator" });
  assert.equal(projection.blocks.get("tool:run:call").status, "not-started");
  assert.equal(projection.interactions.size, 0);

  for (const [code, expected] of [["PERMISSION_DENIED", "denied"], ["TOOL_SKIPPED", "not-started"], ["RUN_CANCELLED", "unknown"], ["BROKEN", "failed"]]) {
    const id = code, next = { ...call, id };
    run("tool.started", { call: next }); run("tool.output.delta", { call: next, delta: "partial output" });
    run("tool.progress", { call: next, message: "Working" });
    run("tool.failed", { call: next, error: { message: "Failure", code, stack: "PRIVATE_STACK" } });
    const block = projection.blocks.get(`tool:run:${id}`);
    assert.equal(block.status, expected); assert.equal(block.text, "partial output");
    assert.deepEqual(block.diagnostic, { message: "Failure", code }); assert.equal(block.progress, "Working");
  }
  permission("approval.requested", { request: { ...request, id: "long", input: "x".repeat(70_000) } });
  assert.deepEqual(projection.interactions.get("long").choices.map(c => c.value), ["deny"]);
  run("run.failed", { error: { code: "MODEL_FAILURE", message: "Model unavailable" } });
  assert.equal(projection.interactions.size, 0);
  assert.equal(projection.blocks.get("run:run").diagnostic.code, "MODEL_FAILURE");
  assert.equal(projection.blocks.get("tool:run:call").status, "unknown");
  history.history([event("run.interrupted", { recoveries: [{ call, status: "not-started" }, { call: { ...call, id: "unknown" }, status: "unknown" }] })]);
  assert.equal(history.blocks.get("tool:run:call").status, "not-started");
  assert.equal(history.blocks.get("tool:run:unknown").status, "unknown");
  assert.ok(!JSON.stringify([...projection.blocks.values()]).includes("PRIVATE_STACK"));
});

// Full-history coverage in one integration scenario, not a separate test per UI control.
test("read APIs page beyond the snapshot, search stored text and bind detail chunks without executing", async t => {
  const store = new InMemorySessionStore(), catalog = new InMemorySessionCatalog();
  let calls = 0, opens = 0;
  const large = "x".repeat(80_000) + "deep-search-marker";
  const definition = defineAgent({ model: { async *stream(request) {
    calls++;
    const last = request.messages.at(-1);
    const text = last?.role === "user" ? last.content.map(p => p.text ?? "").join("") : "Tool complete";
    yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text }], modelState: { type: "private", data: { secret: "DO_NOT_EXPOSE" } },
      ...(text === "large" ? { toolCalls: [{ id: "large-call", name: "fixture", input: {} }] } : {}) } };
  } }, tools: [{ name: "fixture", description: "Fixture", inputSchema: { type: "object" }, execute: () => large }], permissionPolicy: () => "allow", sessionHistory: false });
  const app = await AgentWorkspace.open({ workspace: "reading", store, catalog, openApplication: selection => { opens++; return definition.open({ ...selection, store }); } });
  const host = new ApplicationUiHost(app, { product: { id: "reading", title: "Reading", subtitle: "Fixture", resourceKind: "session", suggestions: [] } });
  const server = await startUiServer({ host, token, port: 0, assets: new Map(), close: () => host.close() }); t.after(() => server.close());
  for (let i = 0; i < 260; i++) await (await app.submit({ input: `turn ${i}` })).result;
  await (await app.submit({ input: "large" })).result;
  const sessionId = app.sessionId;
  for (let i = 0; i < 510; i++) await catalog.record({ id: `catalog-${i}`, workspace: "reading", title: `archived ${i}`, createdAt: i, lastUsedAt: 10_000 + i });
  const before = JSON.stringify(await store.inspect(sessionId)), previousOpens = opens, previousCalls = calls;
  const read = async (kind, args = {}) => fetch(`${server.url}/api/ui/${kind}?${new URLSearchParams({ hostId: host.hostId, selected: sessionId, ...args })}`, { headers: { authorization: `Bearer ${token}` } });
  const snapshot = await host.snapshot(); assert.ok(snapshot.blocks.length <= 50); assert.ok(snapshot.historyPage.total > 500);
  const ids = new Set(); let cursor;
  do {
    const page = await (await read("history", cursor ? { cursor } : {})).json();
    assert.ok(page.items.length <= 50);
    for (const block of page.items) { assert.ok(!ids.has(block.id)); ids.add(block.id); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.size, snapshot.historyPage.total);
  const searched = await (await read("history", { query: "deep-search-marker" })).json();
  const block = searched.items.find(b => b.kind === "tool"); assert.ok(block, "search includes stored output beyond the snapshot truncation");
  assert.ok(!JSON.stringify(searched).includes("DO_NOT_EXPOSE"));
  const first = await (await read("field", { block: block.id, field: "text", offset: "0" })).json();
  assert.equal(first.text.length, 32_768); assert.equal(first.total, large.length);
  const next = await (await read("field", { block: block.id, field: "text", offset: String(first.nextOffset), version: first.version })).json();
  assert.equal(next.offset, first.nextOffset); assert.equal(next.version, first.version);
  assert.equal((await read("field", { block: block.id, field: "text", offset: "1", version: "stale" })).status, 409);
  assert.equal((await read("field", { block: "foreign", field: "text" })).status, 404);
  assert.equal((await read("history", { cursor: snapshot.historyPage.nextCursor, query: "changed" })).status, 409);
  assert.equal((await read("history", { selected: "not-owned" })).status, 404);
  assert.equal((await read("history", { hostId: "old-host" })).status, 409);
  assert.equal((await fetch(`${server.url}/api/ui/history?hostId=${host.hostId}&selected=${sessionId}`)).status, 401);
  assert.equal((await (await read("resources", { query: "archived 0" })).json()).items[0].id, "catalog-0");
  let count = 0; cursor = undefined;
  do { const page = await (await read("resources", cursor ? { cursor } : {})).json(); count += page.items.length; cursor = page.nextCursor; } while (cursor);
  assert.equal(count, 511);
  assert.equal(JSON.stringify(await store.inspect(sessionId)), before);
  assert.equal(app.sessionId, sessionId); assert.equal(opens, previousOpens); assert.equal(calls, previousCalls);
});
