import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadMayConfig } from "@may/config";
import { McpInteractionBroker, openMcpClientPool } from "@may/mcp";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { UiClient } from "@may/ui-client";
import { ApplicationUiHost } from "@may/ui-client/application";
import { AgentWorkspace } from "@may/application";
import { openConfiguredMaybeCode, startMaybeCodeWebUI, MaybeCodeWorkspace, MaybeCodeApplication, createMaybeCodeModel, selectMaybeCodeModel } from "../../dist/index.js";

async function directory() {
  const parent = fileURLToPath(new URL("../../../../review/web-parity", import.meta.url));
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "test-"));
}
async function until(condition) {
  for (let count = 0; count < 100; count++) { if (await condition()) return; await delay(30); }
  assert.fail("状态未在期限内更新");
}
async function connect(app, t) {
  const token = randomBytes(32).toString("base64url");
  const server = await startMaybeCodeWebUI(app, { token, port: 0 });
  t.after(() => server.close());
  const client = new UiClient(server.url);
  t.after(() => client.disconnect());
  await client.connect(token);
  return { client, server, token };
}

test("真实配置：Web 命令、effort 和会话管理", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 60_000 }, async t => {
  const root = await directory();
  const app = await openConfiguredMaybeCode({ workspace: root, dataDirectory: join(root, "data"), mcp: false, skills: false, observability: false });
  const { client } = await connect(app, t);
  const initialHistory = await app.history();
  const slash = text => client.command("console.execute", { text });
  assert.ok((await client.complete("/eff")).items.some(item => item.value === "/effort"));
  for (const name of ["/help", "/status", "/context", "/instructions", "/skills", "/mcp", "/recovery", "/web"]) {
    await slash(name); assert.ok(client.state.output?.text);
  }
  assert.deepEqual(await app.history(), initialHistory);
  await assert.rejects(slash("/unknown"), { status: 400 });
  await assert.rejects(client.command("message.submit", { text: "/new" }), { status: 400 });
  await slash("/model");
  assert.ok(client.state.output.actions.some(action => action.args.action === "model.default"));
  await client.command("console.action", { action: "model.switch", value: app.modelInfo.profile });
  const effort = await app.getReasoningEffort();
  await slash("/effort");
  if (effort.status === "known") {
    const value = effort.efforts[0];
    await client.command("effort.set", { value });
    assert.equal((await app.getReasoningEffort()).effectiveEffort, value);
    assert.equal(client.state.snapshot.choices.find(choice => choice.command === "effort.set").value, value);
    await slash("/effort default");
    assert.equal((await app.getReasoningEffort()).overridden, false);
    const profile = (await app.listModels()).find(model => model.name === app.modelInfo.profile);
    const resetEffort = profile.reasoningEffort ?? effort.defaultEffort;
    assert.ok(client.state.snapshot.choices.find(choice => choice.command === "effort.set").options[0].label.includes(resetEffort ?? "Provider"));
  }
  const first = app.sessionId;
  await slash("/new"); assert.notEqual(app.sessionId, first); assert.equal(client.state.snapshot.selectedId, app.sessionId);
  await slash("/resume");
  await client.command("console.action", { action: "session.rename", value: first, title: "Web 会话" });
  assert.equal((await app.listSessions()).find(session => session.id === first).title, "Web 会话");
  await client.select(first);
  await slash("/effort");
  assert.equal(app.sessionId, first);
  await slash("/new");
  await client.command("console.action", { action: "session.delete", value: first });
  assert.ok(!(await app.listSessions()).some(session => session.id === first));
  await slash("/quit"); assert.equal(client.state.connection, "disconnected");
});

test("真实会话：多页面同步、删除、工作区范围及过期操作", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 60_000 }, async t => {
  const root = await directory();
  const app = await openConfiguredMaybeCode({ workspace: root, dataDirectory: join(root, "data"), mcp: false, skills: false, observability: false });
  const { client: left, server, token } = await connect(app, t);
  const right = new UiClient(server.url); t.after(() => right.disconnect()); await right.connect(token);
  const first = app.sessionId;
  await assert.rejects(left.command("session.delete", {}, first), { status: 409 });
  assert.deepEqual((await app.listSessions()).map(session => session.id), [first]);
  await left.command("session.new"); const second = app.sessionId;
  await until(() => right.state.snapshot.selectedId === second);
  await right.select(first);
  assert.equal(app.sessionId, first);
  await until(() => left.state.snapshot.selectedId === first);
  assert.equal(left.state.snapshot.activeId, left.state.snapshot.selectedId);
  assert.ok(left.state.snapshot.commands.includes("message.submit"));
  const before = await app.history(); await right.readHistory(); assert.deepEqual(await app.history(), before);
  const foreignRoot = await directory();
  const foreign = await openConfiguredMaybeCode({ workspace: foreignRoot, dataDirectory: join(root, "data"), mcp: false, skills: false, observability: false });
  t.after(() => foreign.close());
  await assert.rejects(left.select(foreign.sessionId), { status: 404 });
  await assert.rejects(left.command("session.delete", {}, foreign.sessionId), { status: 404 });
  assert.equal(app.sessionId, first);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (name, targetId, expectedActiveId) => fetch(server.url + "/api/ui/commands", { method: "POST", headers,
    body: JSON.stringify({ version: 1, hostId: left.state.snapshot.hostId, requestId: crypto.randomUUID(), name, targetId, expectedActiveId, args: {} }) });
  const transitions = await Promise.all([post("session.activate", second, first), post("session.new", first, first)]);
  assert.deepEqual(transitions.map(response => response.status).sort(), [200, 409]);
  assert.equal((await post("session.delete", second, first)).status, 409);
  assert.equal((await post("session.new", app.sessionId, undefined)).status, 409);
  await until(() => left.state.snapshot.selectedId === app.sessionId && right.state.snapshot.selectedId === app.sessionId);
  await left.select(first); await right.refresh();
  await left.command("session.delete", {}, second);
  assert.equal(app.sessionId, first);
  assert.ok(!(await right.readResources()).items.some(session => session.id === second));
  await assert.rejects(left.select(second), { status: 404 });
  await assert.rejects(left.command("session.delete", {}, second), { status: 404 });
  for (const session of await app.listSessions()) if (session.id !== first) await left.command("session.delete", {}, session.id);
  await left.command("session.new"); const replacement = app.sessionId;
  await left.select(first);
  const sessions = await app.listSessions(), history = await app.history();
  await assert.rejects(left.command("session.delete", {}, first), { status: 409 });
  await assert.rejects(left.command("console.action", { action: "session.delete", value: first }), { status: 409 });
  assert.equal(app.sessionId, first);
  assert.deepEqual(await app.listSessions(), sessions);
  assert.deepEqual(await app.history(), history);
  await until(() => right.state.snapshot.selectedId === first);
  await left.command("session.delete", {}, replacement);
  assert.deepEqual((await app.listSessions()).map(session => session.id), [first]);
  await app.newSession();
  await until(() => left.state.snapshot.selectedId === app.sessionId && right.state.snapshot.selectedId === app.sessionId);
});

test("真实 MCP broker：Web 表单、review、URL、失效响应和取消", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 60_000 }, async t => {
  const root = await directory();
  const config = await loadMayConfig();
  const broker = new McpInteractionBroker();
  const pool = await openMcpClientPool({ servers: [], interactions: broker });
  const app = await MaybeCodeWorkspace.open({ workspace: root, model: createMaybeCodeModel(selectMaybeCodeModel(config)),
    store: new FileSessionStore(join(root, "sessions")), catalog: new FileSessionCatalog(join(root, "catalog.json")),
    mcp: pool, closeOwnedResources: () => pool.close(), skills: false });
  const { client } = await connect(app, t);
  const initialHistory = await app.history();
  const owner = { workspaceId: app.workspace, sessionId: app.sessionId };
  const pending = async () => {
    await until(async () => { await client.refresh(); return client.state.snapshot.controls.forms.length > 0; });
    return client.state.snapshot.controls.forms[0];
  };
  const request = broker.request("acceptance", "form", owner, { mode: "form", message: "输入验收名称", requestedSchema: {
    type: "object", properties: { name: { type: "string", minLength: 2 } }, required: ["name"],
  } }, new AbortController().signal, Date.now() + 30_000);
  const form = await pending();
  assert.ok(!client.state.snapshot.commands.includes("session.activate"));
  assert.ok(!client.state.snapshot.commands.includes("session.delete"));
  await assert.rejects(client.command("session.delete", {}, app.sessionId), { status: 409 });
  await assert.rejects(client.command("session.new"), { status: 409 });
  await assert.rejects(client.command("session.activate", {}, app.sessionId), { status: 409 });
  await assert.rejects(client.command("console.execute", { text: "/new" }), { status: 409 });
  await assert.rejects(client.interact("mcp.respond", { id: form.id, action: "accept", content: '{"name":"x"}' }));
  const viewing = client.command("console.execute", { text: "/mcp" });
  assert.equal(client.state.busy, true);
  await client.interact("mcp.respond", { id: form.id, action: "accept", content: '{"name":"Web acceptance"}' });
  await viewing;
  assert.equal((await request).content.name, "Web acceptance");
  await assert.rejects(client.interact("mcp.respond", { id: form.id, action: "cancel" }), { status: 409 });
  const review = broker.review("acceptance", "review", owner, { mode: "review", kind: "sampling.request", message: "核查输入", editable: true, data: { maxTokens: 32 } }, new AbortController().signal, Date.now() + 30_000);
  const reviewForm = await pending();
  await client.interact("mcp.respond", { id: reviewForm.id, action: "accept", content: JSON.stringify({ json: '{"maxTokens":16}' }) });
  assert.equal(JSON.parse((await review).content.json).maxTokens, 16);
  const url = broker.request("acceptance", "url", owner, { mode: "url", message: "核查网站", url: "https://example.com/" }, new AbortController().signal, Date.now() + 30_000);
  const urlForm = await pending(); assert.equal(urlForm.mode, "url");
  await client.interact("mcp.respond", { id: urlForm.id, action: "decline" }); assert.equal((await url).action, "decline");
  const cancelled = broker.review("acceptance", "cancel", owner, { mode: "review", kind: "roots", message: "核查工作区", editable: false, data: [] }, new AbortController().signal, Date.now() + 30_000);
  await pending(); await client.interact("console.cancel"); assert.equal((await cancelled).action, "cancel");
  assert.deepEqual(await app.history(), initialHistory);
});

test("真实 Workspace：状态转换等待 MCP review 时仍可读取活动会话快照", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 10_000 }, async t => {
  const root = await directory();
  const model = createMaybeCodeModel(selectMaybeCodeModel(await loadMayConfig()));
  const store = new FileSessionStore(join(root, "sessions"));
  const app = await AgentWorkspace.open({ workspace: root, store, catalog: new FileSessionCatalog(join(root, "catalog.json")),
    openApplication: selection => MaybeCodeApplication.open({ ...selection, workspace: root, model, store, skills: false }),
  });
  const broker = new McpInteractionBroker();
  const host = new ApplicationUiHost(app, { product: { id: "maybecode", title: "MaybeCode", subtitle: "", resourceKind: "session", suggestions: [] } });
  t.after(async () => { broker.close(); await host.close(); });
  const owner = { workspaceId: app.workspace, sessionId: app.sessionId };
  const transition = app.runStateTransition(() => broker.review("acceptance", "roots", owner, { mode: "review", kind: "roots", message: "核查工作区", data: [app.workspace], editable: false }, new AbortController().signal, Date.now() + 5000));
  void transition.catch(() => {});
  await until(() => broker.list(owner).length > 0);
  const snapshot = await Promise.race([host.snapshot(), delay(1000).then(() => { throw new Error("快照被等待交互的状态队列阻塞"); })]);
  assert.equal(snapshot.activeId, app.sessionId);
  assert.equal(broker.respond(broker.list(owner)[0].id, owner, { action: "accept" }), true);
  assert.equal((await transition).action, "accept");
});

test("真实独立 Web 进程：退出命令关闭 HTTP 服务和宿主", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 30_000 }, async t => {
  const root = await directory(), token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/bin.js", import.meta.url)), "--ui", "web", "--port", "0", root], {
    windowsHide: true, env: { ...process.env, MAYBECODE_CONTROL_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
  await until(() => /MaybeCode Web UI: http:\/\/127\.0\.0\.1:\d+/.test(output));
  const url = output.match(/MaybeCode Web UI: (http:\/\/127\.0\.0\.1:\d+)/)[1];
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const snapshot = await (await fetch(url + "/api/ui/snapshot", { headers })).json();
  assert.ok(snapshot.controls);
  const response = await fetch(url + "/api/ui/commands", { method: "POST", headers, body: JSON.stringify({ version: 1, hostId: snapshot.hostId, requestId: "quit", targetId: snapshot.activeId, name: "console.execute", args: { text: "/quit" } }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).disconnect, true);
  assert.equal(await exited, 0);
  await assert.rejects(fetch(url + "/api/ui/snapshot", { headers }));
});
