import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CoordinationRuntime } from "@may/coordination";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { actorKey } from "../dist/gateway-types.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/gateway-restore-access/", import.meta.url));
const module = fileURLToPath(new URL("../dist/gateway-rpc-adapter.js", import.meta.url));
const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
const operator = { kind: "operator", id: "restore-review" };
const entry = { account: "telegram:42", conversation: "-10012", kind: "group" };
const actor = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "7" };
const content = "Gateway recovery file verification\n";
const operation = JSON.stringify({ operation: "sha256", path: "input.txt" });

async function setup(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "restore-"));
  await writeFile(join(directory, "input.txt"), content);
  const settings = gatewaySettings({ apps: { maybeclaw: { version: 2, server: { shutdownMs: 0 }, agents: ["files", "healthy"].map(id => ({ id, adapter: "module", module,
    options: { transport: "stdio", command: process.execPath, args: [example, "--directory", join(directory, "rpc", id), "--workspace", directory] } })) } } });
  const gateways = [];
  const open = (path = join(directory, "gateway"), config = settings) => {
    const gateway = new AgentGateway({ directory: path, configPath: join(directory, "config.json"), settings: config });
    gateways.push(gateway); return gateway;
  };
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, settings, open, gateway: open() };
}

async function until(probe) {
  for (let attempt = 0; attempt < 200; attempt++) { const result = await probe(); if (result) return result; await delay(20); }
  throw new Error("Gateway recovery condition timed out");
}

async function queued(gateway, agentId = "healthy", owner = operator) {
  const session = gateway.createSession(operator, randomUUID(), [agentId], [], owner.kind === "platform" ? entry : undefined);
  const message = gateway.record(session, { kind: "user", text: operation, actor: owner });
  const id = randomUUID();
  gateway.store.put("graphs", id, { id, sessionId: session.id, actor: owner, messageId: message.id });
  const runtime = await CoordinationRuntime.create({ id, store: gateway.coordinationStore(), agents: gateway.coordinationAgents(session, owner, id), policy: gateway.policy(session, owner), tasks: [{ id: "request-0", agent: agentId, input: operation }] });
  await runtime.close();
  return { graphId: id, taskId: `${id}:request-0` };
}

async function completed(gateway, taskId) {
  const task = await until(() => { const task = gateway.store.get("tasks", taskId); return task && ["completed", "failed", "cancelled", "recovery-required"].includes(task.status) && task; });
  assert.equal(task.status, "completed", task.detail);
  assert.equal(task.result, createHash("sha256").update(content).digest("hex"));
}

test("撤销权限后的真实运行记录保留待核对状态，其他会话通过RPC进程恢复", async t => {
  const { gateway, directory, settings, open } = await setup(t);
  const session = gateway.createSession(operator, "运行中的成员工作", ["files"], [], entry);
  const receipt = await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "pending.txt" }), actor, { requestId: "waiting", sessionId: session.id });
  const taskId = receipt.taskIds[0];
  await until(async () => {
    const task = gateway.store.get("tasks", taskId), binding = gateway.store.get("bindings", `${session.id}:files`);
    return task?.status === "running" && binding?.conversationId && (await (await gateway.adapter("files")).inspect(binding.conversationId, task.inputId)).status === "running";
  });
  const snapshotDirectory = join(directory, "restarted");
  await mkdir(snapshotDirectory);
  const database = new DatabaseSync(join(directory, "gateway", "gateway.sqlite"));
  try { await backup(database, join(snapshotDirectory, "gateway.sqlite")); } finally { database.close(); }
  await gateway.close();
  const config = structuredClone(settings); config.access.deniedUsers.push(actorKey(actor));
  const restarted = open(snapshotDirectory, config), healthy = await queued(restarted);
  await restarted.restore();
  const blocked = restarted.store.get("tasks", taskId);
  assert.equal(blocked.status, "recovery-required");
  assert.match(blocked.detail, /权限已经撤销/);
  assert.equal(restarted.adapters.has("files"), false);
  await completed(restarted, healthy.taskId);
});

for (const change of ["agent", "policy"]) test(`${change}配置版本变化只阻止所属任务图`, async t => {
  const { gateway, settings } = await setup(t);
  const blocked = await queued(gateway, "files");
  if (change === "agent") settings.agents[0].name = "updated files";
  else settings.access.creators.push("telegram:42:99");
  const healthy = await queued(gateway);
  await gateway.restore();
  const task = gateway.store.get("tasks", blocked.taskId);
  assert.equal(task.status, "recovery-required");
  assert.match(task.detail, change === "agent" ? /Agent files.*版本/ : /访问配置版本/);
  assert.equal(gateway.adapters.has("files"), false);
  await completed(gateway, healthy.taskId);
});

test("恢复遇到损坏的持久任务图时直接报告错误", async t => {
  const { gateway } = await setup(t);
  const queuedTask = await queued(gateway);
  const snapshot = gateway.store.get("coordination", queuedTask.graphId);
  gateway.store.put("coordination", queuedTask.graphId, { ...snapshot, format: 9 });
  await assert.rejects(gateway.restore(), /journal identity\/format/);
  assert.equal(gateway.store.get("tasks", queuedTask.taskId), undefined);
  assert.equal(gateway.adapters.size, 0);
});

test("恢复未创建的对话重新请求有效审批，原审批保持失效", async t => {
  const { gateway, directory, open } = await setup(t);
  const session = gateway.createSession(operator, "恢复创建审批", ["files"]);
  const receipt = await gateway.handle(`@healthy -- ${operation}`, operator, { requestId: "approval-restart", sessionId: session.id });
  const original = await until(() => gateway.store.list("approvals").find(item => item.sessionId === session.id && item.status === "pending"));
  const snapshotDirectory = join(directory, "approval-restarted");
  await mkdir(snapshotDirectory);
  const database = new DatabaseSync(join(directory, "gateway", "gateway.sqlite"));
  try { await backup(database, join(snapshotDirectory, "gateway.sqlite")); } finally { database.close(); }
  await gateway.close();
  const restarted = open(snapshotDirectory);
  await restarted.restore();
  const current = await until(() => restarted.store.list("approvals").find(item => item.sessionId === session.id && item.status === "pending"));
  assert.notEqual(current.id, original.id);
  await assert.rejects(restarted.resolveApproval(original.id, operator, "allow"), /已经处理/);
  await restarted.resolveApproval(current.id, operator, "allow");
  await completed(restarted, receipt.taskIds[0]);
});
