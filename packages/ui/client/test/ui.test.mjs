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
  let resolveOld, posts = 0;
  const request = async function (url, init) {
    assert.equal(this, globalThis, "browser fetch requires the Window receiver");
    if (init.method === "POST") { posts++; throw new Error("Response lost"); }
    if (url.includes("events")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
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
  await assert.rejects(client.select("missing")); await client.refresh();
  assert.equal(client.state.snapshot.selectedId, "new"); assert.equal(client.state.selecting, false);
  await assert.rejects(client.command("message.submit", { text: "hi" }), /Response lost/);
  assert.equal(posts, 1); assert.match(client.state.error, /未自动重发/); client.disconnect();
});

test("two clients browse independently without opening runtimes and explicitly guard execution transitions", async t => {
  const store = new InMemorySessionStore(), catalog = new InMemorySessionCatalog();
  let opened = 0;
  const definition = defineAgent({ model: { async *stream(request) {
    const last = request.messages.at(-1);
    yield { type: "response.completed", message: last?.role === "user" && last.content.some(p => p.text === "pause")
      ? { role: "assistant", content: [], toolCalls: [{ id: "approval", name: "check", input: {} }] }
      : { role: "assistant", content: [{ type: "text", text: "Stored answer" }] } };
  } }, tools: [{ name: "check", description: "Fixture", inputSchema: { type: "object" }, execute: () => "ok" }], permissionPolicy: () => "ask", sessionHistory: false });
  const openApplication = selection => { opened++; return definition.open({ ...selection, store }); };
  const app = await AgentWorkspace.open({ workspace: "owned", store, catalog, openApplication });
  const first = app.sessionId;
  await (await app.submit({ input: "seed" })).result;
  const foreign = await AgentWorkspace.open({ workspace: "other", store, catalog, openApplication });
  t.after(() => foreign.close());
  const host = new ApplicationUiHost(app, { product: { id: "fixture", title: "Fixture", subtitle: "", resourceKind: "session", suggestions: [] } });
  const server = await startUiServer({ host, token, port: 0, assets: new Map(), close: () => host.close() }); t.after(() => server.close());
  const left = new UiClient(server.url), right = new UiClient(server.url);
  t.after(() => { left.disconnect(); right.disconnect(); });
  await left.connect(token); await right.connect(token);
  await left.command("session.new"); const second = app.sessionId;
  await right.refresh();
  assert.equal(right.state.snapshot.selectedId, first);
  assert.equal(right.state.snapshot.activeId, second);
  assert.equal(left.state.snapshot.selectedId, second);
  assert.ok(right.state.snapshot.commands.includes("session.activate"));
  assert.ok(!right.state.snapshot.commands.includes("message.submit"));
  await left.command("message.submit", { text: "pause" });
  await until(async () => { await left.refresh(); return left.state.snapshot.interactions.length; });
  const beforeCatalog = await catalog.list("owned"), beforeHistory = await store.inspect(first), beforeOpened = opened;
  await right.select(first); await right.refresh();
  assert.deepEqual(await catalog.list("owned"), beforeCatalog);
  assert.deepEqual(await store.inspect(first), beforeHistory);
  assert.equal(opened, beforeOpened);
  assert.equal(app.sessionId, second); assert.equal(app.isRunning, true);
  assert.deepEqual(right.state.snapshot.interactions, []);
  assert.ok(!right.state.snapshot.commands.includes("session.activate"));
  for (const name of ["message.submit", "run.cancel", "session.activate"]) await assert.rejects(right.command(name, name === "message.submit" ? { text: "wrong target" } : {}));
  await assert.rejects(right.select(foreign.sessionId));
  assert.equal(right.state.snapshot.selectedId, first);
  await assert.rejects(host.snapshot("unknown"));
  await left.command("approval.resolve", { id: left.state.snapshot.interactions[0].id, decision: "allow" });
  await until(() => !app.isRunning);
  await left.select(first); await right.refresh();
  const settled = await Promise.allSettled([left.command("session.activate"), right.command("session.new")]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1, "a stale execution owner cannot authorize a second transition");
  await left.refresh(); await right.refresh();
  assert.equal(left.state.snapshot.selectedId, first);
  if (settled[0].status === "fulfilled") { assert.equal(app.sessionId, first); assert.equal(right.state.snapshot.selectedId, first); }
  else { assert.notEqual(app.sessionId, first); assert.notEqual(app.sessionId, second); assert.equal(right.state.snapshot.selectedId, app.sessionId); }
  await assert.rejects(host.execute({ version: 1, hostId: host.hostId, requestId: "missing-guard", name: "session.new", targetId: app.sessionId, args: {} }));
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
