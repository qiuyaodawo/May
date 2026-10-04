import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReadTool, createWriteTool } from "@may/coding-tools";
import { PermissionToolExecutor, PermissionDeniedError } from "@may/permissions";
import { FilePermissionRuleStore } from "@may/permissions/file-store";
import { createGatewayPermissionPolicy } from "../dist/gateway-adapters.js";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { GatewayUiHost } from "../dist/gateway-ui.js";
import { startGatewayServer } from "../dist/gateway-server.js";

const parent = fileURLToPath(new URL("../../../review/persistent-rules/", import.meta.url));
const operator = { kind: "operator", id: "control" };
const actorScope = JSON.stringify(["operator", operator.id]);

async function fixture(t, enabled = true) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "gateway-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "guide.md"), "Persistent permissions document");
  const agent = { id: "writer", adapter: "may", readDirectory: workspace, permissions: { read: "ask" } };
  const configuration = { providers: {}, apps: { maybeclaw: { version: 2, persistentRules: enabled, agents: [agent] } } };
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(configuration));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace, agent, configPath, settings: gatewaySettings(configuration), path: join(directory, "permission-rules.json") };
}

function execution(tool, path = "guide.md") {
  return { tool, input: { path }, context: {
    runId: "permission_run", step: 1, toolCallId: "read_document",
    idempotencyKey: "permission_run:1:read_document", signal: new AbortController().signal, report() {},
  } };
}

async function seed(f, overrides = {}) {
  const store = await FilePermissionRuleStore.open({ path: f.path });
  const policy = createGatewayPermissionPolicy({ directory: f.directory, agent: f.agent, permissionRuleStore: store }, () => actorScope);
  const permissions = new PermissionToolExecutor({ policy, ruleStore: store });
  try {
    const call = execution(createReadTool({ cwd: f.workspace }));
    return await permissions.createRule(call, { createdBy: "operator:control", decision: "allow", ...overrides });
  } finally { await permissions.close(); await store.close(); }
}

test("MaybeClaw persistent rules configuration requires a boolean and remains opt-in", () => {
  const raw = { apps: { maybeclaw: { version: 2, agents: [] } } };
  assert.equal(gatewaySettings(raw).persistentRules, false);
  raw.apps.maybeclaw.persistentRules = true;
  assert.equal(gatewaySettings(raw).persistentRules, true);
  raw.apps.maybeclaw.persistentRules = "true";
  assert.throws(() => gatewaySettings(raw), /persistentRules/);
});

test("saved read permissions survive reopening and isolate actor, Agent, and workspace identities", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const store = await FilePermissionRuleStore.open({ path: f.path });
  const originalPolicy = createGatewayPermissionPolicy({ directory: f.directory, agent: f.agent, permissionRuleStore: store }, () => actorScope);
  const permissions = new PermissionToolExecutor({ policy: originalPolicy, ruleStore: store });
  try {
    const read = createReadTool({ cwd: f.workspace });
    assert.equal((await permissions.execute(execution(read))).content, "Persistent permissions document");
    const otherWorkspace = join(f.directory, "other-workspace");
    await mkdir(otherWorkspace);
    await writeFile(join(otherWorkspace, "guide.md"), "Other project");
    for (const [agent, identity, tool] of [
      [f.agent, JSON.stringify(["operator", "another"]), read],
      [f.agent, JSON.stringify(["platform", "telegram:42", "7"]), read],
      [{ ...f.agent, id: "reviewer" }, actorScope, read],
      [{ ...f.agent, readDirectory: otherWorkspace }, actorScope, createReadTool({ cwd: otherWorkspace })],
    ]) {
      const isolated = new PermissionToolExecutor({ ruleStore: store,
        policy: createGatewayPermissionPolicy({ directory: f.directory, agent, permissionRuleStore: store }, () => identity) });
      try {
        const events = isolated.events[Symbol.asyncIterator]();
        const result = isolated.execute(execution(tool));
        const rejected = assert.rejects(result, PermissionDeniedError);
        const event = (await events.next()).value;
        assert.equal(event.type, "approval.requested");
        await isolated.resolve(event.request.id, "deny");
        await rejected;
      } finally { await isolated.close(); }
    }
  } finally { await permissions.close(); await store.close(); }
});

test("read scope rejects project escape paths and directory junctions using actual filesystem paths", async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "Outside document");
  await symlink(outside, join(f.workspace, "external"), process.platform === "win32" ? "junction" : "dir");
  const store = await FilePermissionRuleStore.open({ path: f.path });
  const policy = createGatewayPermissionPolicy({ directory: f.directory, agent: f.agent, permissionRuleStore: store }, () => actorScope);
  const read = createReadTool({ cwd: f.workspace });
  try {
    for (const path of ["../outside/secret.md", "external/secret.md", join(outside, "secret.md")]) {
      await assert.rejects(policy(execution(read, path)), /workspace|outside/i);
    }
    assert.equal((await policy(execution(read))).decision, "ask");
  } finally { await store.close(); }
});

test("explicit deny remains authoritative and persistent input keys exclude parameter contents", async (t) => {
  const f = await fixture(t);
  const store = await FilePermissionRuleStore.open({ path: f.path });
  try {
    const denied = createGatewayPermissionPolicy({ directory: f.directory, agent: { ...f.agent, permissions: { read: "deny" } }, permissionRuleStore: store }, () => actorScope);
    assert.equal(await denied(execution(createReadTool({ cwd: f.workspace }))), "deny");
    const policy = createGatewayPermissionPolicy({ directory: f.directory, agent: { ...f.agent, permissions: { write: "ask" } }, permissionRuleStore: store }, () => actorScope);
    const check = execution(createReadTool({ cwd: f.workspace }));
    const input = { path: "guide.md", content: "Private document contents" };
    const write = createWriteTool({ cwd: f.workspace });
    const scoped = await policy({ ...check, tool: write, input });
    assert.match(scoped.grantKey, /^exact-input-v1:[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(scoped).includes(input.content), false);
    const permissions = new PermissionToolExecutor({ policy, ruleStore: store });
    try {
      const saved = await permissions.createRule({ ...check, tool: write, input }, { decision: "allow", createdBy: "operator:control" });
      assert.equal(JSON.stringify(saved).includes(input.content), false);
      assert.equal((await readFile(f.path, "utf8")).includes(input.content), false);
    } finally { await permissions.close(); }
    const unconfigured = createGatewayPermissionPolicy({ directory: f.directory, agent: f.agent, permissionRuleStore: store }, () => actorScope);
    assert.equal(await unconfigured({ ...check, tool: write, input }), "ask");
  } finally { await store.close(); }
});

test("exact input scopes require a lossless JSON representation and keep ordinary JSON matching stable", async (t) => {
  const f = await fixture(t);
  const store = await FilePermissionRuleStore.open({ path: f.path });
  try {
    const policy = createGatewayPermissionPolicy({ directory: f.directory, agent: { ...f.agent, permissions: { write: "ask" } }, permissionRuleStore: store }, () => actorScope);
    const call = execution(createWriteTool({ cwd: f.workspace }));
    const input = { path: "guide.md", content: "Document", value: null };
    const ordinary = await policy({ ...call, input });
    assert.equal((await policy({ ...call, input: JSON.parse(JSON.stringify(input)) })).grantKey, ordinary.grantKey);
    const changed = await policy({ ...call, input: { ...input, value: 0 } });
    assert.notEqual(changed.grantKey, ordinary.grantKey);
    for (const value of [Infinity, -Infinity, NaN, undefined, -0, [undefined], Array(1), { omitted: undefined }]) {
      await assert.rejects(policy({ ...call, input: { ...input, value } }), TypeError);
    }
    await assert.rejects(policy({ ...call, input: undefined }), TypeError);
    await assert.rejects(policy({ ...call, input: 1n }), TypeError);
    assert.deepEqual(await store.list(), []);
  } finally { await store.close(); }
});

test("Gateway administrators create and revoke rules using verified existing scopes across restart", async (t) => {
  const f = await fixture(t);
  const original = await seed(f);
  const gateway = new AgentGateway(f);
  const member = { kind: "platform", account: "telegram:42", conversation: "100", userId: "7" };
  const ui = new GatewayUiHost(gateway);
  try {
    await assert.rejects(gateway.listPermissionRules(member), /服务管理员/);
    await assert.rejects(gateway.createPermissionRule(original.id, "deny", member), /服务管理员/);
    await assert.rejects(gateway.revokePermissionRule(original.id, member), /服务管理员/);
    assert.deepEqual(await gateway.listPermissionRules(operator), [original]);
    await assert.rejects(FilePermissionRuleStore.open({ path: f.path }), { code: "EEXIST" });
    const command = { version: 1, hostId: ui.hostId, targetId: null, requestId: "create-deny", name: "permission.rule.create", args: { sourceId: original.id, decision: "deny" } };
    const receipt = await ui.execute(command);
    const deny = JSON.parse(receipt.output.text);
    assert.equal(deny.decision, "deny");
    assert.equal(deny.createdBy, "operator:control");
    for (const field of ["scopeId", "definitionKey", "toolName", "grantKey", "description"]) assert.equal(deny[field], original[field]);
    await assert.rejects(ui.execute({ ...command, requestId: "scope-injection", args: { ...command.args, scopeId: "other" } }));
    assert.equal(await gateway.revokePermissionRule(original.id, operator), true);
    assert.equal(await gateway.revokePermissionRule(original.id, operator), false);
    assert.equal(gateway.store.list("permission-rule-events").length, 2);
  } finally { ui.close(); await gateway.close(); }
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  const restarted = new AgentGateway(f);
  try {
    const rules = await restarted.listPermissionRules(operator);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].decision, "deny");
    f.settings.agents[0].readDirectory = await realpath(f.directory);
    await assert.rejects(restarted.createPermissionRule(rules[0].id, "allow", operator), /项目目录/);
  } finally { await restarted.close(); }
});

test("disabled Gateway keeps persistent storage unopened and rejects management", async (t) => {
  const f = await fixture(t, false);
  const gateway = new AgentGateway(f);
  try {
    await assert.rejects(gateway.listPermissionRules(operator), /尚未启用/);
    await assert.rejects(lstat(f.path), { code: "ENOENT" });
    await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  } finally { await gateway.close(); }
});

test("Agent file tools cannot access rule storage, ownership files, or replacement files", async (t) => {
  const f = await fixture(t);
  const store = await FilePermissionRuleStore.open({ path: f.path });
  const agent = { ...f.agent, readDirectory: f.directory, permissions: { read: "allow", write: "allow", edit: "allow" } };
  const policy = createGatewayPermissionPolicy({ directory: f.directory, agent, permissionRuleStore: store }, () => actorScope);
  await symlink(f.directory, join(f.workspace, "host-data"), process.platform === "win32" ? "junction" : "dir");
  try {
    for (const tool of [createReadTool({ cwd: f.directory }), createWriteTool({ cwd: f.directory })]) {
      for (const path of ["permission-rules.json", "permission-rules.json.lock", "permission-rules.json.pending.tmp", "workspace/host-data/permission-rules.json"]) {
        const call = execution(tool, path);
        assert.equal(await policy(call), "deny");
        const permissions = new PermissionToolExecutor({ policy, ruleStore: store });
        try { await assert.rejects(permissions.execute(call), PermissionDeniedError); }
        finally { await permissions.close(); }
      }
    }
    assert.deepEqual(await store.list(), []);
  } finally { await store.close(); }
});

test("real authenticated HTTP clients manage persistent rules without submitting replacement scopes", async (t) => {
  const f = await fixture(t);
  const original = await seed(f);
  const password = randomBytes(32).toString("base64url");
  const configuration = JSON.parse(await readFile(f.configPath, "utf8"));
  configuration.apps.maybeclaw.server = { auth: { password } };
  await writeFile(f.configPath, JSON.stringify(configuration));
  const gateway = new AgentGateway(f);
  const server = await startGatewayServer({ gateway, port: 0 });
  try {
    const endpoint = new URL("/api/permission-rules", server.url);
    assert.equal((await fetch(endpoint)).status, 401);
    const login = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const snapshot = await (await fetch(new URL("/api/ui/snapshot", server.url), { headers })).json();
    assert.ok(snapshot.panels.find(panel => panel.id === "permission-rules").actions.length > 0);
    const listed = await fetch(endpoint, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [original]);
    const injected = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ sourceId: original.id, decision: "allow", scopeId: "arbitrary" }) });
    assert.equal(injected.status, 400);
    const created = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ sourceId: original.id, decision: "deny" }) });
    assert.equal(created.status, 201);
    const rule = await created.json();
    assert.equal(rule.scopeId, original.scopeId);
    assert.equal(rule.grantKey, original.grantKey);
    assert.equal(rule.decision, "deny");
    const removed = await fetch(new URL(`/api/permission-rules/${rule.id}/revoke`, server.url), { method: "POST", headers, body: "{}" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { revoked: true });
  } finally { await server.close(); }
});
