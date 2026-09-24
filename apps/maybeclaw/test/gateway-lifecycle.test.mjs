import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { GatewayStore } from "../dist/gateway-store.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-lifecycle-tests/", import.meta.url));
const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
const modulePath = fileURLToPath(new URL("../dist/gateway-rpc-adapter.js", import.meta.url));
const operator = { kind: "operator", id: "service-admin" };

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const agent = { id: "files", adapter: "module", module: modulePath, idleMs: 25, options: {
    transport: "stdio", command: process.execPath, args: [example, "--directory", join(directory, "agent-state"), "--workspace", directory],
  } };
  const configuration = { providers: {}, models: {}, apps: { maybeclaw: { version: 2, agents: [agent, { ...agent, id: "reviewer" }] } } };
  const configPath = join(directory, "may.config.json");
  await writeFile(configPath, JSON.stringify(configuration));
  const gateway = new AgentGateway({ directory, configPath, settings: gatewaySettings(configuration) });
  t.after(async () => {
    await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, gateway, configPath, agent };
}

async function until(probe) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await probe()) return; await delay(10); }
  throw new Error("Condition timed out");
}

test("Agent configuration waits for real execution and prevents new admission", async (t) => {
  const { gateway, directory, agent, configPath } = await fixture(t);
  const session = gateway.createSession(operator, "执行期间更新", ["files"]);
  const receipt = await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "ready.txt" }), operator, { requestId: "wait", sessionId: session.id });
  const taskId = receipt.taskIds[0];
  await until(() => gateway.store.get("tasks", taskId)?.status === "running");
  const binding = gateway.store.get("bindings", `${session.id}:files`);
  const adapter = await gateway.adapter("files");
  await until(async () => (await adapter.inspect(binding.conversationId, gateway.store.get("tasks", taskId).inputId)).status === "running");
  const { pid } = JSON.parse(await adapter.command(binding.conversationId, "process", []));
  let updated = false;
  const change = gateway.updateAgent("files", operator, { ...agent, name: "更新后的 Agent" }).then(() => { updated = true; });
  await assert.rejects(gateway.handle(JSON.stringify({ operation: "sha256", path: "ready.txt" }), operator, { requestId: "rejected-new", sessionId: session.id }), /不可用/);
  assert.equal(updated, false);
  assert.equal(process.kill(pid, 0), true);
  await writeFile(join(directory, "ready.txt"), "ready");
  await change;
  assert.equal(gateway.store.get("tasks", taskId).status, "completed");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).apps.maybeclaw.agents.find(value => value.id === "files").name, "更新后的 Agent");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const reopened = await gateway.adapter("files");
  assert.notEqual(JSON.parse(await reopened.command(binding.conversationId, "process", [])).pid, pid);
  assert.equal((await reopened.inspect(binding.conversationId, gateway.store.get("tasks", taskId).inputId)).status, "completed");
});

test("Agent status reports failed loading and successful configuration repair", async (t) => {
  const { gateway, directory, agent } = await fixture(t);
  const status = () => gateway.status().agents.find(item => item.id === "files").status;
  assert.equal(status(), "unloaded");
  await gateway.updateAgent("files", operator, { ...agent, options: { ...agent.options, command: join(directory, "missing-agent.exe") } });
  await assert.rejects(gateway.adapter("files"), /ENOENT/);
  assert.equal(status(), "unavailable");
  assert.match((await gateway.handle("/agent list", operator, { requestId: "failed-agents" })).text, /files\s+unavailable/);
  await gateway.updateAgent("files", operator, agent);
  assert.equal(status(), "unloaded");
  await gateway.adapter("files");
  assert.equal(status(), "loaded");
  await delay(35);
  await gateway.maintain();
  assert.equal(status(), "unloaded");
  await gateway.updateAgent("files", operator, { ...agent, enabled: false });
  assert.equal(status(), "disabled");
});

test("accepted creation approval can complete while Agent reconfiguration waits", async (t) => {
  const { gateway, agent } = await fixture(t);
  const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
  const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "member" };
  const session = gateway.createSession(operator, "审批期间更新", ["files"], [], entry);
  await gateway.handle("/agent create reviewer", member, { requestId: "create-reviewer", sessionId: session.id, entry });
  const [approval] = gateway.store.list("approvals");
  let updated = false;
  const change = gateway.updateAgent("reviewer", operator, { ...agent, id: "reviewer", name: "新配置" }).then(() => { updated = true; });
  await delay(15);
  assert.equal(updated, false);
  await gateway.resolveApproval(approval.id, operator, "allow");
  await change;
  assert.equal(gateway.store.get("approvals", approval.id).status, "allowed");
  const binding = gateway.store.get("bindings", `${session.id}:reviewer`);
  assert.equal(binding.status, "ready");
  assert.equal((await (await gateway.adapter("reviewer")).inspectCreation(binding.requestId)).conversationId, binding.conversationId);
});

test("unknown execution and waiting coordination prevent configuration replacement", async (t) => {
  const { gateway, agent, configPath } = await fixture(t);
  const session = gateway.createSession(operator, "等待恢复", ["files"]);
  const task = { id: "graph:request", sessionId: session.id, agentId: "files", graphId: "graph", graphTaskId: "request", actor: operator, input: "saved input", inputId: "dispatch:0", status: "recovery-required", createdAt: 1, updatedAt: 1 };
  gateway.store.put("tasks", task.id, task);
  const original = await readFile(configPath, "utf8");
  await assert.rejects(gateway.updateAgent("files", operator, { ...agent, name: "changed" }), /核对/);
  gateway.store.put("tasks", task.id, { ...task, status: "waiting" });
  gateway.store.put("coordination", "graph", { format: 1, id: "graph", revision: 2, policyVersion: "access", limits: { maxConcurrent: 1, maxTasks: 64, maxOutputBytes: 1024 }, commands: {}, tasks: [
    { id: "request", agent: "files", input: task.input, dependsOn: [], agentVersion: "saved", dispatchId: "dispatch", sessionId: "agent-session", status: "waiting", waitForMessages: true },
  ] });
  await assert.rejects(gateway.updateAgent("files", operator, { ...agent, name: "changed" }), /等待|协作任务/);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(gateway.options.settings.agents.find(value => value.id === "files"), agent);
});

test("failed process creation wakes the configuration waiter with an unknown approval outcome", async (t) => {
  const { gateway, agent, directory } = await fixture(t);
  gateway.options.settings.agents.find(value => value.id === "reviewer").options.command = join(directory, "unavailable-agent.exe");
  const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
  const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "member" };
  const session = gateway.createSession(operator, "启动失败审批", ["files"], [], entry);
  await gateway.handle("/agent create reviewer", member, { requestId: "unavailable-reviewer", sessionId: session.id, entry });
  const [approval] = gateway.store.list("approvals");
  const rejected = assert.rejects(gateway.updateAgent("reviewer", operator, { ...agent, id: "reviewer" }), /核对/);
  await assert.rejects(gateway.resolveApproval(approval.id, operator, "allow"), /ENOENT/);
  await rejected;
  assert.equal(gateway.store.get("approvals", approval.id).status, "unknown");
});

test("all idle conversations release their shared process and preserve conversation identities", async (t) => {
  const { gateway } = await fixture(t);
  const first = gateway.createSession(operator, "空闲 A", ["files"]);
  const second = gateway.createSession(operator, "空闲 B", ["files"]);
  await gateway.handle("/agent create files", operator, { requestId: "create-a", sessionId: first.id });
  await gateway.handle("/agent create files", operator, { requestId: "create-b", sessionId: second.id });
  const firstBinding = gateway.store.get("bindings", `${first.id}:files`);
  const secondBinding = gateway.store.get("bindings", `${second.id}:files`);
  const adapter = await gateway.adapter("files");
  const { pid } = JSON.parse(await adapter.command(firstBinding.conversationId, "process", []));
  assert.equal(JSON.parse(await adapter.command(secondBinding.conversationId, "process", [])).pid, pid);
  await delay(35);
  await gateway.maintain();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await gateway.maintain();
  assert.deepEqual(gateway.store.list("bindings"), [firstBinding, secondBinding]);
  const reopened = await gateway.adapter("files");
  assert.notEqual(JSON.parse(await reopened.command(firstBinding.conversationId, "process", [])).pid, pid);
  assert.equal((await reopened.inspectCreation(firstBinding.requestId)).conversationId, firstBinding.conversationId);
  assert.equal((await reopened.inspectCreation(secondBinding.requestId)).conversationId, secondBinding.conversationId);
});

test("an active conversation retains the shared process through idle maintenance", async (t) => {
  const { gateway, directory } = await fixture(t);
  const session = gateway.createSession(operator, "活动资源", ["files"]);
  const receipt = await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "pending.txt" }), operator, { requestId: "pending", sessionId: session.id });
  await until(() => gateway.store.get("tasks", receipt.taskIds[0])?.status === "running");
  const adapter = await gateway.adapter("files"), binding = gateway.store.get("bindings", `${session.id}:files`);
  const { pid } = JSON.parse(await adapter.command(binding.conversationId, "process", []));
  await delay(35);
  await gateway.maintain();
  assert.equal(process.kill(pid, 0), true);
  await writeFile(join(directory, "pending.txt"), "finished");
  await until(() => gateway.store.get("tasks", receipt.taskIds[0])?.status === "completed");
});

test("concurrent shutdown shares completion and cancels execution before waiting for configuration", async (t) => {
  const { gateway, agent, directory } = await fixture(t);
  gateway.options.settings.shutdownMs = 20;
  const session = gateway.createSession(operator, "关闭期间更新", ["files"]);
  const receipt = await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "shutdown.txt" }), operator, { requestId: "shutdown-work", sessionId: session.id });
  const taskId = receipt.taskIds[0];
  await until(() => gateway.store.get("tasks", taskId)?.status === "running");
  const binding = gateway.store.get("bindings", `${session.id}:files`), adapter = await gateway.adapter("files");
  await until(async () => (await adapter.inspect(binding.conversationId, gateway.store.get("tasks", taskId).inputId)).status === "running");
  const { pid } = JSON.parse(await adapter.command(binding.conversationId, "process", []));
  const rejected = assert.rejects(gateway.updateAgent("files", operator, { ...agent, name: "未应用配置" }), /关闭|等待|协作任务/);
  const first = gateway.close(), second = gateway.close();
  assert.equal(second, first);
  await Promise.all([first, second, rejected]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const store = GatewayStore.open(directory);
  try { assert.equal(store.get("tasks", taskId).status, "cancelled"); }
  finally { store.close(); }
});

test("shutdown finishes an admitted conversation creation before releasing SQLite ownership", async (t) => {
  const { gateway, directory } = await fixture(t);
  const session = gateway.createSession(operator, "创建期间关闭", ["files"]);
  const creation = gateway.handle("/agent create files", operator, { requestId: "create-during-close", sessionId: session.id });
  const closing = gateway.close();
  const receipt = await creation;
  assert.equal(receipt.sessionId, session.id);
  await closing;
  const store = GatewayStore.open(directory);
  try { assert.equal(store.get("bindings", `${session.id}:files`).status, "ready"); }
  finally { store.close(); }
});

test("shutdown wakes configuration waiting on an unresolved approval", async (t) => {
  const { gateway, agent, directory } = await fixture(t);
  const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
  const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "member" };
  const session = gateway.createSession(operator, "待审批关闭", ["files"], [], entry);
  await gateway.handle("/agent create reviewer", member, { requestId: "shutdown-approval", sessionId: session.id, entry });
  const [approval] = gateway.store.list("approvals");
  const rejected = assert.rejects(gateway.updateAgent("reviewer", operator, { ...agent, id: "reviewer" }), /关闭/);
  await Promise.all([gateway.close(), rejected]);
  const store = GatewayStore.open(directory);
  try { assert.equal(store.get("approvals", approval.id).status, "cancelled"); }
  finally { store.close(); }
});
