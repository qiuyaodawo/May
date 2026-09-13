import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentWorkspace, defineAgent } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "../dist/application.js";
import { startUiServer } from "../dist/server.js";
import { UiClient } from "../dist/index.js";

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
  await clients[1].refresh();
  assert.equal(clients[1].state.snapshot.interactions[0].id, pending.interactions[0].id);
  const approval = { ...command, requestId: "approve-1", name: "approval.resolve", args: { id: pending.interactions[0].id, decision: "allow" } };
  assert.equal((await request("/api/ui/commands", approval)).status, 200);
  await until(() => !app.isRunning);
  const finished = await (await request("/api/ui/snapshot")).json();
  assert.equal(toolCalls, 1); assert.equal(calls, 2); assert.equal(finished.interactions.length, 0);
  assert.equal(finished.blocks.filter(b => b.kind === "user").length, 1);
  assert.ok(finished.blocks.filter(b => b.kind === "assistant").every(b => b.text || b.reasoning), "tool-only responses must not render empty assistant bubbles");
  assert.ok(finished.blocks.some(b => b.text.includes("<script>")));
  assert.ok(!JSON.stringify(finished).includes("NEVER_TRANSMIT"));
  assert.equal((await request("/api/ui/commands", { ...approval, requestId: "approve-stale" })).status, 409);
  assert.equal((await request("/api/ui/commands", { ...command, requestId: "old-host", hostId: "old" })).status, 409);
  await request("/api/ui/commands", { ...command, requestId: "new-session", name: "session.new", args: {} });
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
    return Response.json(snapshot(url.includes("selected=new") ? "new" : null));
  };
  t.mock.method(globalThis, "fetch", request);
  const client = new UiClient();
  t.after(() => client.disconnect());
  await client.connect(token);
  const old = client.select("old"); await client.select("new"); resolveOld(); await old;
  assert.equal(client.state.snapshot.selectedId, "new");
  await assert.rejects(client.command("message.submit", { text: "hi" }), /Response lost/);
  assert.equal(posts, 1); assert.match(client.state.error, /未自动重发/); client.disconnect();
});
