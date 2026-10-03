import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { GatewayHost } from "../dist/gateway-host.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { startGatewayServer } from "../dist/gateway-server.js";
import { entryKey } from "../dist/gateway-types.js";

const execute = promisify(execFile);
const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-http-tests/", import.meta.url));
const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function fixture(t, publicOrigin) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const password = randomBytes(32).toString("base64url");
  const configuration = { providers: {}, models: {}, apps: { maybeclaw: { version: 2, server: { auth: { password }, ...(publicOrigin ? { publicOrigin } : {}) }, agents: [{ id: "code", adapter: "may" }, { id: "reviewer", adapter: "may" }] } } };
  const configPath = join(directory, "may.config.json"); await writeFile(configPath, JSON.stringify(configuration));
  const gateway = new AgentGateway({ directory, configPath, settings: gatewaySettings(configuration) });
  const host = await GatewayHost.start({ gateway, adapters: [] });
  let closeCalls = 0;
  const server = await startGatewayServer({ gateway, port: 0, status: () => host.status(), close: () => { closeCalls++; return host.close(); }, retryLegacyDelivery: (id, confirm) => host.retryLegacyDelivery(id, { kind: "operator", id: "test" }, confirm) });
  const token = await login(server, password);
  t.after(async () => { await server.close(); assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true }); });
  async function request(path, data, extra = {}) {
    return fetch(new URL(path, server.url), { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  return { directory, gateway, token, password, server, request, configPath, closeCalls: () => closeCalls };
}

async function login(server, password) {
  const response = await fetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200); return (await response.json()).token;
}

test("real HTTP authentication, command creation, and UI browsing preserve entrance defaults", async t => {
  const { gateway, request, server } = await fixture(t);
  assert.equal((await fetch(`${server.url}/api/v2/sessions`)).status, 401);
  assert.equal((await request("/api/v2/sessions", undefined, { origin: "https://invalid.example" })).status, 403);
  const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
  const created = await request("/api/v2/sessions", { name: "项目 A", agents: ["code"], allowedAgents: ["reviewer"], entry, requestId: "create-a" });
  assert.equal(created.status, 201); const first = (await created.json()).session;
  const second = await request("/api/v2/commands", { text: '/session create "项目 B" --agent reviewer', entry, requestId: "create-b" });
  assert.equal(second.status, 200); const secondId = (await second.json()).selectedId;
  await request("/api/v2/commands", { text: `/session select ${first.id}`, entry, requestId: "select-a" });
  const view = await request(`/api/ui/snapshot?selected=${secondId}`); const snapshot = await view.json();
  assert.equal(snapshot.selectedId, secondId); assert.equal(snapshot.activeId, undefined);
  assert.ok(snapshot.commands.includes("session.activate"));
  assert.equal(gateway.store.get("defaults", entryKey(entry)).sessionId, first.id);
  assert.equal((await request("/api/v2/tasks", { prompt: "缺少会话", requestId: "missing-session" })).status, 400);
  assert.equal((await request("/api/ui/commands", { version: 1, hostId: snapshot.hostId, requestId: "ordinary-without-session", name: "message.submit", targetId: null, args: { text: "hello" } })).status, 400);
  assert.deepEqual(gateway.session(first.id, { kind: "operator", id: "test" }).allowedAgents, ["code", "reviewer"]);
});

test("password login and real CLI clients share the Gateway control service", async t => {
  const { request, server, token, password } = await fixture(t);
  assert.notEqual(await login(server, password), token);
  const result = await execute(process.execPath, [cli, "session", "create", "CLI 创建", "--agent", "code", "--server", server.url], { env: { ...process.env, MAYBECLAW_ADMIN_PASSWORD: password } });
  assert.ok(JSON.parse(result.stdout).selectedId);
  const sessions = await (await request("/api/v2/sessions")).json(); assert.equal(sessions[0].name, "CLI 创建");
  const list = await execute(process.execPath, [cli, "session", "list", "--server", server.url, "--password-env", "TEST_GATEWAY_PASSWORD"], { env: { ...process.env, TEST_GATEWAY_PASSWORD: password } });
  assert.equal(JSON.parse(list.stdout)[0].id, sessions[0].id);
  await assert.rejects(execute(process.execPath, [cli, "task", "submit", "没有会话"]), error => error.code === 2 && error.stderr.includes("--session"));
});

test("local CLI creates and queries persistent sessions without contacting a model", async t => {
  const { directory, server, configPath } = await fixture(t); await server.close();
  const common = ["--config", configPath, "--data-directory", directory];
  const created = await execute(process.execPath, [cli, "session", "create", "本地会话", "--agent", "code", ...common]);
  const id = JSON.parse(created.stdout).selectedId;
  const listed = await execute(process.execPath, [cli, "session", "list", ...common]);
  assert.equal(JSON.parse(listed.stdout)[0].id, id);
  await assert.rejects(execute(process.execPath, [cli, "session", "list", "--agent", "code", ...common]), error => error.code === 2);
  await assert.rejects(execute(process.execPath, [cli, "session", "list", "unexpected", ...common]), error => error.code === 2);
});

test("legacy delivery retry requires explicit confirmation of uncertain sends", async t => {
  const { gateway, request, server, password } = await fixture(t);
  gateway.store.put("legacy-deliveries", "uncertain", { kind: "delivery", id: "uncertain", account: "telegram:42", sender: "7", conversation: "7", text: "保存的工作结果", status: "unknown" });
  assert.equal((await request("/api/v2/legacy-deliveries/uncertain/retry", {})).status, 400);
  const result = await execute(process.execPath, [cli, "delivery", "retry-legacy", "uncertain", "--confirm", "--server", server.url], { env: { ...process.env, MAYBECLAW_ADMIN_PASSWORD: password } });
  assert.equal(JSON.parse(result.stdout).delivery.status, "pending");
  assert.equal(gateway.store.get("legacy-deliveries", "uncertain").status, "pending");
  gateway.store.put("channel-replies", "reply", { id: "reply", text: "渠道回复", input: { account: "telegram:42", conversation: "7", sender: "7" }, status: "unknown" });
  assert.equal((await request("/api/v2/deliveries/reply/retry", {})).status, 400);
  const reply = await execute(process.execPath, [cli, "delivery", "retry", "reply", "--confirm", "--server", server.url], { env: { ...process.env, MAYBECLAW_ADMIN_PASSWORD: password } });
  assert.equal(JSON.parse(reply.stdout).delivery.status, "pending");
});

test("configured HTTPS proxy origin and Host are checked without trusting forwarded headers", async t => {
  const { server, token } = await fixture(t, "https://gateway.example:8443");
  const request = headers => new Promise((resolveStatus, reject) => {
    const call = httpRequest(`${server.url}/api/v2/sessions`, { headers: { authorization: `Bearer ${token}`, ...headers } }, response => { response.resume(); response.on("end", () => resolveStatus(response.statusCode)); });
    call.on("error", reject); call.end();
  });
  assert.equal(await request({}), 200);
  assert.equal(await request({ host: "gateway.example:8443", origin: "https://gateway.example:8443" }), 200);
  assert.equal(await request({ host: "gateway.example:8443", origin: "https://untrusted.example" }), 403);
  assert.equal(await request({ host: "untrusted.example", origin: "https://gateway.example:8443" }), 403);
  assert.equal(await request({ host: "untrusted.example", "x-forwarded-host": "gateway.example:8443", "x-forwarded-proto": "https" }), 403);
  assert.equal(server.publicUrl, "https://gateway.example:8443");
});

test("session request identity survives control server restart", async t => {
  const { directory, configPath, gateway, request, server, token, password } = await fixture(t);
  const input = { name: "持久创建请求", agents: ["code"], requestId: "persistent-create" };
  const first = await (await request("/api/v2/sessions", input)).json();
  const settings = gateway.options.settings;
  await server.close();
  const reopened = new AgentGateway({ directory, configPath, settings });
  const nextServer = await startGatewayServer({ gateway: reopened, port: 0 });
  try {
    assert.equal((await fetch(`${nextServer.url}/api/v2/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    const nextToken = await login(nextServer, password);
    const response = await fetch(`${nextServer.url}/api/v2/sessions`, { method: "POST", headers: { authorization: `Bearer ${nextToken}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).session.id, first.session.id);
    assert.equal(reopened.sessions({ kind: "operator", id: "test" }).length, 1);
  } finally { await nextServer.close(); }
});

test("HTTP shutdown cancels actual RPC file work while an Agent configuration request waits", { timeout: 15_000 }, async t => {
  const { directory, gateway, request, server, configPath, closeCalls } = await fixture(t);
  gateway.options.settings.shutdownMs = 0;
  const actor = { kind: "operator", id: "test" };
  const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
  const agent = { id: "files", adapter: "module", module: "@may/plugin-agent-adapters/rpc",
    options: { transport: "stdio", command: process.execPath, args: [example, "--directory", join(directory, "state"), "--workspace", directory] } };
  await gateway.updateAgent(agent.id, actor, agent);
  const session = gateway.createSession(actor, "file wait", [agent.id]);
  await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "arriving.txt" }), actor, { requestId: "waiting", sessionId: session.id });
  const until = async probe => {
    const deadline = Date.now() + 10_000;
    while (!await probe()) { assert.ok(Date.now() < deadline, "Gateway state did not become ready"); await delay(10); }
  };
  let update;
  try {
    await until(async () => {
      const task = gateway.store.list("tasks")[0], binding = gateway.store.list("bindings")[0];
      return task && binding?.conversationId && (await (await gateway.adapter(agent.id)).inspect(binding.conversationId, task.inputId)).status === "running";
    });
    const task = gateway.store.list("tasks")[0], binding = gateway.store.list("bindings")[0];
    const { pid } = JSON.parse(await (await gateway.adapter(agent.id)).command(binding.conversationId, "process", []));
    update = request("/api/v2/agents", { id: agent.id, config: { ...agent, name: "updated" } }).then(response => response.text(), () => undefined);
    await until(() => gateway.status().agents.find(value => value.id === agent.id).status === "reconfiguring");
    const closing = server.close();
    assert.equal(server.close(), closing);
    await Promise.race([closing, delay(5000).then(() => { throw new Error("HTTP shutdown did not cancel the file wait"); })]);
    await update; assert.equal(closeCalls(), 1);
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
    const saved = JSON.parse(await readFile(join(directory, "state", `${binding.conversationId}-${createHash("sha256").update(task.inputId).digest("hex")}.json`), "utf8"));
    assert.equal(saved.status, "cancelled");
    const configuration = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(configuration.apps.maybeclaw.agents.find(value => value.id === agent.id).name, undefined);
  } finally {
    await writeFile(join(directory, "arriving.txt"), "release file wait during test cleanup");
    await server.close(); await update;
  }
});

test("HTTP close shares an actual cleanup failure after releasing Gateway and listener resources", async t => {
  const { directory, configPath, gateway, server } = await fixture(t);
  const settings = gateway.options.settings; await server.close();
  const reopened = new AgentGateway({ directory, configPath, settings });
  let closes = 0;
  const next = await startGatewayServer({ gateway: reopened, port: 0, close: async () => {
    closes++; await reopened.close(); await readFile(join(directory, "missing-cleanup-resource"));
  } });
  const first = next.close(), second = next.close();
  assert.equal(first, second);
  const failures = await Promise.allSettled([first, second]);
  assert.equal(failures[0].status, "rejected"); assert.equal(failures[1].status, "rejected");
  assert.equal(failures[0].reason, failures[1].reason); assert.equal(closes, 1);
  const containsMissingFile = error => error?.code === "ENOENT" || containsMissingFileInChildren(error);
  const containsMissingFileInChildren = error => Boolean(error?.cause && containsMissingFile(error.cause))
    || Boolean(error?.errors?.some(containsMissingFile));
  assert.ok(containsMissingFile(failures[0].reason));
  await assert.rejects(fetch(next.url));
  const final = new AgentGateway({ directory, configPath, settings }); await final.close();
});
