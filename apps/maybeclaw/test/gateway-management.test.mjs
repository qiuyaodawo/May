import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { gatewayEntry, gatewaySettings } from "../dist/gateway-settings.js";
import { gatewayInput } from "../dist/gateway-input.js";
import { actorKey, entryKey } from "../dist/gateway-types.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-management-tests/", import.meta.url));
const operator = { kind: "operator", id: "service-admin" };
const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "123" };
const manager = { ...member, userId: "456" };

function configuration(overrides = {}) {
  return { apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }, { id: "reviewer", adapter: "may" }], ...overrides } } };
}

async function fixture(t, overrides = {}) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const configPath = join(directory, "may.config.json");
  await writeFile(configPath, JSON.stringify(configuration(overrides)));
  const settings = gatewaySettings(configuration(overrides));
  const gateways = [];
  function open() {
    const gateway = new AgentGateway({ directory, configPath, settings });
    gateways.push(gateway);
    return gateway;
  }
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, settings, gateway: open(), open };
}

test("session managers come from server configuration and shared defaults persist", async (t) => {
  const { gateway, settings, open } = await fixture(t);
  const first = gateway.createSession(operator, "项目 A", ["code"], [], entry);
  const second = gateway.createSession(operator, "项目 B", ["code", "reviewer"], [], entry);
  settings.access.sessionAdmins[first.id] = [actorKey(manager)];
  settings.access.sessionAdmins[second.id] = [actorKey(manager)];
  assert.equal(gateway.isAdmin(first, manager), true);
  assert.equal(gateway.isAdmin(first, member), false);
  await assert.rejects(gateway.handle(`/session select ${first.id}`, member, { requestId: "member-select", entry }), /管理员/);
  await gateway.handle(`/session select ${first.id}`, manager, { requestId: "manager-select", entry });
  assert.equal(gateway.store.get("defaults", entryKey(entry)).sessionId, first.id);
  await gateway.handle("/agent default reviewer", manager, { requestId: "manager-default", entry });
  assert.deepEqual(gateway.session(first.id, member).defaultAgents, ["reviewer"]);
  await assert.rejects(gateway.handle("/agent default code", member, { requestId: "member-default", entry }), /管理员/);
  await gateway.close();
  const reopened = open();
  assert.equal(reopened.store.get("defaults", entryKey(entry)).sessionId, first.id);
  assert.deepEqual(reopened.session(first.id, member).defaultAgents, ["reviewer"]);
  assert.deepEqual(reopened.session(second.id, member).defaultAgents, ["code", "reviewer"]);
});

test("personal sessions bind one platform identity and group sessions stay within their entrance", async (t) => {
  const { gateway } = await fixture(t);
  const privateEntry = { account: "telegram:42", conversation: "123", kind: "private", owner: "123" };
  const owner = { kind: "platform", account: privateEntry.account, conversation: privateEntry.conversation, userId: "123" };
  const personal = gateway.createSession(owner, "个人会话", ["code"], [], privateEntry);
  assert.equal(gateway.canAccess(personal, owner), true);
  assert.equal(gateway.canAccess(personal, { ...owner, userId: "456" }), false);
  assert.equal(gateway.canAccess(personal, { ...owner, account: "feishu:other" }), false);
  const group = gateway.createSession(operator, "群聊会话", ["code"], [], { ...entry, threadId: "7" });
  assert.equal(gateway.canAccess(group, { ...member, threadId: "7" }), true);
  assert.equal(gateway.canAccess(group, { ...member, threadId: "8" }), false);
  assert.equal(gateway.canAccess(group, member), false);
});

test("concurrent retries reject different payloads under the same request ID", async (t) => {
  const { gateway } = await fixture(t);
  const input = { requestId: "same-request" };
  const first = gateway.handle('/session create "Alpha" --agent code', operator, input);
  const second = gateway.handle('/session create "Beta" --agent code', operator, input);
  await first;
  await assert.rejects(second, /请求 ID|request ID/);
  assert.deepEqual(gateway.sessions(operator).map(session => session.name), ["Alpha"]);
});

test("completed command receipts survive restart and preserve the original session ID", async (t) => {
  const { gateway, open } = await fixture(t);
  const command = '/session create "Alpha" --agent code';
  const original = await gateway.handle(command, operator, { requestId: "create-once" });
  await gateway.close();
  const reopened = open();
  assert.deepEqual(await reopened.handle(command, operator, { requestId: "create-once" }), original);
  assert.equal(reopened.sessions(operator).length, 1);
  await assert.rejects(reopened.handle('/session create "Changed" --agent code', operator, { requestId: "create-once" }), /请求 ID/);
});

test("interrupted command admission retains its intent and cannot create a duplicate session", async (t) => {
  const { gateway, directory, open } = await fixture(t);
  await gateway.close();
  const gatewayUrl = new URL("../dist/gateway.js", import.meta.url).href;
  const settingsUrl = new URL("../dist/gateway-settings.js", import.meta.url).href;
  const command = '/session create "Interrupted" --agent code';
  const script = `import { AgentGateway } from ${JSON.stringify(gatewayUrl)};
import { gatewaySettings } from ${JSON.stringify(settingsUrl)};
const gateway = new AgentGateway({ directory: process.argv[1], configPath: process.argv[1] + "/may.config.json", settings: gatewaySettings(JSON.parse(process.argv[2])) });
gateway.observe(() => { if (gateway.store.list("sessions").length === 1) process.exit(7); });
await gateway.handle(process.argv[3], { kind: "operator", id: "service-admin" }, { requestId: "interrupted-create" });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, directory, JSON.stringify(configuration()), command], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 7, result.stderr);
  await unlink(join(directory, "host.lock"));
  const reopened = open();
  await assert.rejects(reopened.handle(command, operator, { requestId: "interrupted-create" }), /未确认|需要核对|尚未确认|尚无确认/);
  assert.deepEqual(reopened.sessions(operator).map(session => session.name), ["Interrupted"]);
});

test("creation approval is decided by an appointed manager and only once", async (t) => {
  const { gateway, settings } = await fixture(t);
  const session = gateway.createSession(operator, "Review", ["code"], [], entry);
  settings.access.sessionAdmins[session.id] = [actorKey(manager)];
  const input = { requestId: "create-reviewer", sessionId: session.id, entry };
  await gateway.handle("/agent create reviewer", member, input);
  const [approval] = gateway.store.list("approvals");
  assert.equal(approval.kind, "create-agent");
  assert.equal(approval.status, "pending");
  await assert.rejects(gateway.resolveApproval(approval.id, member, "deny"), /管理员/);
  await gateway.resolveApproval(approval.id, manager, "deny");
  assert.equal(gateway.store.get("approvals", approval.id).status, "denied");
  await assert.rejects(gateway.resolveApproval(approval.id, manager, "allow"), /已经处理/);
  assert.deepEqual(gateway.session(session.id, member).allowedAgents, ["code"]);
  assert.deepEqual(gateway.store.list("bindings"), []);
});

test("approval response checks the initiating member's current access", async (t) => {
  const { gateway, settings } = await fixture(t);
  const session = gateway.createSession(operator, "Review", ["code"], [], entry);
  settings.access.sessionAdmins[session.id] = [actorKey(manager)];
  await gateway.handle("/agent create reviewer", member, { requestId: "revoked-approval", sessionId: session.id, entry });
  const [approval] = gateway.store.list("approvals");
  settings.access.deniedUsers.push(actorKey(member));
  await assert.rejects(gateway.resolveApproval(approval.id, manager, "allow"), /访问权限已失效/);
  assert.deepEqual(gateway.store.list("bindings"), []);
});

test("expired approvals cannot authorize a conversation and remain visible", async (t) => {
  const { gateway } = await fixture(t, { server: { approvalMs: 5 } });
  const session = gateway.createSession(operator, "Review", ["code"], [], entry);
  await gateway.handle("/agent create reviewer", member, { requestId: "expired-approval", sessionId: session.id, entry });
  const [approval] = gateway.store.list("approvals");
  await new Promise(resolve => setTimeout(resolve, Math.max(1, approval.expiresAt - Date.now() + 2)));
  await gateway.maintain();
  assert.equal(gateway.store.get("approvals", approval.id).status, "expired");
  await assert.rejects(gateway.resolveApproval(approval.id, operator, "allow"), /已经过期/);
  assert.deepEqual(gateway.store.list("bindings"), []);
});

test("archived sessions reject conversation creation before loading an Agent", async (t) => {
  const { gateway } = await fixture(t);
  const session = gateway.createSession(operator, "Archived", ["code"]);
  await gateway.manageSession(session, operator, "archive");
  await assert.rejects(gateway.handle("/agent create reviewer", operator, { requestId: "archived-create", sessionId: session.id }), /归档|恢复会话/);
  assert.deepEqual(gateway.store.list("bindings"), []);
});

test("configuration validates Agent identities, adapter requirements and integer limits", () => {
  assert.throws(() => gatewaySettings(configuration({ version: 1 })), /version: 2/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "same", adapter: "may" }, { id: "same", adapter: "may" }] })), /重复/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "external", adapter: "module" }] })), /module/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "..\/escape", adapter: "may" }] })), /Agent ID/);
  assert.throws(() => gatewaySettings(configuration({ server: { maxConcurrent: 0 } })), /maxConcurrent/);
  assert.throws(() => gatewaySettings(configuration({ server: { approvalMs: 1.5 } })), /正.*整数/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "code", adapter: "may", permissions: { read: "sometimes" } }] })), /permissions/);
});

test("routing keeps message punctuation, quotes, indentation and line breaks", () => {
  const body = '\n  const text = "review | check";\n  // user\'s input\n';
  assert.equal(gatewayInput(body).body, body);
  const routed = gatewayInput(`/session "项目 A" @reviewer /steer\n${body}`);
  assert.deepEqual(routed.words.slice(0, 4), ["/session", "项目 A", "@reviewer", "/steer"]);
  assert.equal(routed.body, body);
  assert.equal(gatewayInput(`@reviewer -- ${body}`).body, body);
  assert.equal(gatewayInput('@reviewer   const value = "x";').body, '  const value = "x";');
});

test("misspelled permission settings fail during configuration validation", () => {
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "code", adapter: "may", permissons: { read: "deny" } }] })), /permissons|未知|Unknown/);
  assert.throws(() => gatewaySettings(configuration({ access: { deniedUser: [actorKey(member)] } })), /deniedUser|未知|Unknown/);
});

test("quoted session names can match command words without becoming commands", async (t) => {
  const { gateway } = await fixture(t);
  const session = gateway.createSession(operator, "list", ["code"]);
  const parsed = gatewayInput('/session "list" /history');
  assert.equal(parsed.literalSession, true);
  assert.equal(gatewayInput("/session list").literalSession, undefined);
  const result = await gateway.handle('/session "list" /history', operator, { requestId: "quoted-session" });
  assert.equal(result.sessionId, session.id);
  assert.match(result.text, /暂无历史/);
});

test("entry and Agent configuration validation rejects ambiguous identities and references", () => {
  assert.deepEqual(gatewayEntry(entry), entry);
  assert.throws(() => gatewayEntry({ ...entry, kind: "private" }), /owner/);
  assert.throws(() => gatewayEntry({ ...entry, owner: "123" }), /owner/);
  assert.throws(() => gatewayEntry({ ...entry, threadId: " 7" }), /首尾空白/);
  assert.throws(() => gatewayEntry({ ...entry, owners: ["123"] }), /未知字段/);
  assert.throws(() => gatewaySettings(configuration({ access: { allowedAgents: { scope: ["unregistered"] } } })), /未登记/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "code", adapter: "may", runBudget: { maxSteps: -1 } }] })), /maxSteps/);
  assert.throws(() => gatewaySettings(configuration({ agents: [{ id: "code", adapter: "may", readDirectory: "relative" }] })), /绝对目录/);
  assert.throws(() => gatewaySettings(configuration({ runBudget: { maxSteps: 1 } })), /agents\[\]\.runBudget/);
  assert.throws(() => gatewaySettings(configuration({ server: { shutdownMs: 2_147_483_648 } })), /定时器/);
});

test("public control origin requires canonical HTTPS origin without credentials or URL suffixes", () => {
  assert.equal(gatewaySettings(configuration({ server: { publicOrigin: "https://control.example.com" } })).publicOrigin, "https://control.example.com");
  assert.equal(gatewaySettings(configuration({ server: { publicOrigin: "https://control.example.com:8443" } })).publicOrigin, "https://control.example.com:8443");
  for (const publicOrigin of ["http://control.example.com", "https://control.example.com/", "https://control.example.com/path", "https://control.example.com?key=1", "https://control.example.com#part", "https://user:secret@control.example.com", "https://control.example.com:443", "https://CONTROL.example.com"]) {
    assert.throws(() => gatewaySettings(configuration({ server: { publicOrigin } })), /publicOrigin/);
  }
});

test("gatewaySettings accepts empty array and omitted agents, rejects non-array agents", () => {
  assert.deepEqual(gatewaySettings(configuration({ agents: [] })).agents, []);
  const omitted = { apps: { maybeclaw: { version: 2 } } };
  assert.deepEqual(gatewaySettings(omitted).agents, []);
  for (const bad of [null, {}, "bad", 123, true]) {
    assert.throws(() => gatewaySettings(configuration({ agents: bad })), /agents 必须为列表/);
  }
});

test("gateway with empty agents rejects session creation without residues and allows adding first agent", async (t) => {
  const { gateway, directory } = await fixture(t, { agents: [] });
  assert.throws(() => gateway.createSession(operator, "无Agent会话", []), /创建会话需要名称和至少一个默认 Agent/);
  assert.throws(() => gateway.createSession(operator, "无Agent会话", ["unregistered"]), /Agent unregistered 不可用/);
  assert.equal(gateway.sessions(operator).length, 0);

  const adapterPath = fileURLToPath(new URL("../dist/gateway-rpc-adapter.js", import.meta.url));
  const options = { transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url)), "--directory", join(directory, "rpc-state"), "--workspace", directory] };
  await gateway.updateAgent("code", operator, { id: "code", adapter: "module", module: adapterPath, options });
  assert.equal(gateway.status().agents.length, 1);
  const session = gateway.createSession(operator, "首个会话", ["code"]);
  assert.equal(session.name, "首个会话");
  assert.equal(gateway.sessions(operator).length, 1);

  await gateway.handle("/agent create code", operator, { requestId: "req-create-1", sessionId: session.id });
  const binding = gateway.store.get("bindings", `${session.id}:code`);
  assert.ok(binding);
  assert.equal(binding.status, "ready");
  assert.ok(binding.conversationId);

  await assert.rejects(gateway.updateAgent("code", operator, null), /仍有关联对话/);

  await gateway.manageSession(session, operator, "delete", true);
  assert.equal(gateway.store.get("bindings", `${session.id}:code`), undefined);
  await gateway.updateAgent("code", operator, null);
  assert.equal(gateway.status().agents.length, 0);

  await gateway.updateAgent("reviewer", operator, { id: "reviewer", adapter: "module", module: adapterPath, options });
  assert.equal(gateway.status().agents.length, 1);
  assert.equal(gateway.status().agents[0].id, "reviewer");
});

test("external invalid agents in configuration rejects updateAgent and preserves original file", async (t) => {
  const { gateway, directory } = await fixture(t, { agents: [] });
  const configPath = join(directory, "may.config.json");
  const invalidContent = JSON.stringify({
    providers: {},
    models: {},
    apps: { maybeclaw: { version: 2, agents: null, server: { auth: { password: "admin-password-123" } } } },
  });
  await writeFile(configPath, invalidContent);

  await assert.rejects(
    gateway.updateAgent("code", operator, { id: "code", adapter: "may" }),
    /agents 必须为列表/,
  );

  const preserved = await readFile(configPath, "utf8");
  assert.equal(preserved, invalidContent);
});
