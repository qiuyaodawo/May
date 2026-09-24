import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { actorKey, entryKey } from "../dist/gateway-types.js";
import { inboxId } from "../dist/channel-store.js";
import { digest } from "../dist/types.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-recovery-tests/", import.meta.url));
const operator = { kind: "operator", id: "service-admin" };
const entry = { account: "telegram:42", conversation: "-100", kind: "group" };

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const settings = gatewaySettings({ apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }] } } });
  const gateways = [];
  function open() {
    const gateway = new AgentGateway({ directory, configPath: join(directory, "may.config.json"), settings });
    gateways.push(gateway);
    return gateway;
  }
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, gateway: open(), open };
}

function completedGraph(gateway, session, id = "completed-graph") {
  const message = { id: `${id}:input`, sessionId: session.id, seq: 1, kind: "user", text: "检查修改", actor: operator, createdAt: 1000, sourceMessageId: "platform-source" };
  const graph = { id, sessionId: session.id, actor: operator, messageId: message.id, rootInputId: `${id}:steering` };
  const source = { id: "request-0", agent: "code", input: message.text, dependsOn: [], agentVersion: "configured-version", dispatchId: `${id}-dispatch`, sessionId: "coordination-session", status: "completed", output: { text: "检查结果", runId: "completed-run" } };
  const snapshot = { format: 1, id, revision: 3, policyVersion: "access-version", limits: { maxConcurrent: 1, maxTasks: 64, maxOutputBytes: 1024 }, tasks: [source], commands: {} };
  gateway.store.transaction(() => {
    gateway.store.put("messages", message.id, message);
    gateway.store.put("sequences", session.id, { seq: 1 });
    gateway.store.put("graphs", id, graph);
    gateway.store.put("coordination", id, snapshot);
  });
  return { graph, source, snapshot, message, taskId: `${id}:request-0` };
}

test("terminal coordination records restore missing Gateway results exactly once across restart", async (t) => {
  const { gateway, open } = await fixture(t);
  const session = gateway.createSession(operator, "检查", ["code"], [], entry);
  const { taskId, graph } = completedGraph(gateway, session);
  await gateway.restore();
  const task = gateway.store.get("tasks", taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.inputId, graph.rootInputId);
  assert.equal(task.result, "检查结果");
  assert.equal(task.runId, "completed-run");
  assert.equal(task.createdAt, 1000);
  const [answer] = gateway.messages(session.id, operator).filter(message => message.kind === "assistant");
  assert.equal(answer.seq, 2);
  const [delivery] = gateway.store.list("deliveries");
  assert.equal(delivery.messageId, answer.id);
  assert.equal(delivery.replyTo, "platform-source");
  assert.equal(delivery.status, "pending");
  await gateway.close();
  const reopened = open();
  await reopened.restore();
  assert.deepEqual(reopened.messages(session.id, operator).filter(message => message.kind === "assistant"), [answer]);
  assert.deepEqual(reopened.store.list("deliveries"), [delivery]);
});

test("SQLite delivery rejection rolls back the task, answer, sequence and session update together", async (t) => {
  const { gateway, directory } = await fixture(t);
  const session = gateway.createSession(operator, "原子写入", ["code"], [], entry);
  const { taskId, graph, source } = completedGraph(gateway, session);
  const task = { id: taskId, sessionId: session.id, graphId: graph.id, graphTaskId: source.id, agentId: "code", actor: operator, input: source.input, inputId: "pending-input", status: "running", createdAt: 1000, updatedAt: 1001, detail: "需要核对" };
  gateway.store.put("tasks", taskId, task);
  const database = new DatabaseSync(join(directory, "gateway.sqlite"));
  try {
    database.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON records WHEN NEW.collection = 'deliveries' BEGIN SELECT RAISE(ABORT, 'delivery rejected'); END;");
    await assert.rejects(gateway.restore(), /delivery rejected/);
    assert.deepEqual(gateway.store.get("tasks", taskId), task);
    assert.equal(gateway.messages(session.id, operator).length, 1);
    assert.deepEqual(gateway.store.get("sequences", session.id), { seq: 1 });
    assert.deepEqual(gateway.session(session.id, operator), session);
    assert.deepEqual(gateway.store.list("deliveries"), []);
    database.exec("DROP TRIGGER reject_delivery;");
    await gateway.restore();
    assert.equal(gateway.store.get("tasks", taskId).status, "completed");
    assert.equal(gateway.store.get("tasks", taskId).detail, undefined);
    assert.equal(gateway.messages(session.id, operator).length, 2);
    assert.equal(gateway.store.list("deliveries").length, 1);
  } finally { database.close(); }
});

test("terminal restoration projects failure and cancellation without fabricating assistant results", async (t) => {
  const { gateway } = await fixture(t);
  const session = gateway.createSession(operator, "终态恢复", ["code"]);
  const { graph, snapshot, source } = completedGraph(gateway, session);
  const { output: _output, ...baseTask } = source;
  gateway.store.put("coordination", graph.id, { ...snapshot, tasks: [
    { ...baseTask, status: "failed", detail: "工具执行失败" },
    { ...baseTask, id: "request-1", sessionId: "coordination-session-1", dispatchId: "dispatch-request-1", status: "cancelled", detail: "用户已取消" },
  ] });
  await gateway.restore();
  assert.deepEqual(gateway.store.list("tasks").map(task => [task.status, task.detail]), [["failed", "工具执行失败"], ["cancelled", "用户已取消"]]);
  assert.equal(gateway.messages(session.id, operator).length, 1);
  assert.deepEqual(gateway.store.list("deliveries"), []);
});

test("session deletion clears all associated records and retains request deduplication", async (t) => {
  const { gateway } = await fixture(t);
  const command = '/session create "删除目标" --agent code';
  const request = { requestId: "create-deleted-session", entry };
  const receipt = await gateway.handle(command, operator, request);
  const session = gateway.session(receipt.sessionId, operator);
  const survivor = gateway.createSession(operator, "保留会话", ["code"], [], entry);
  const { taskId } = completedGraph(gateway, session);
  await gateway.restore();
  const input = { ...entry, sender: "123", eventId: "request-a", messageId: "source-a", text: "删除目标的正文" };
  const id = inboxId(input);
  const actor = { kind: "platform", account: input.account, conversation: input.conversation, userId: input.sender };
  const channelReceiptId = digest({ actor: actorKey(actor), requestId: `channel:${id}` });
  gateway.store.put("receipts", channelReceiptId, { id: channelReceiptId, fingerprint: "retained-digest", sessionId: session.id, result: { sessionId: session.id, text: input.text } });
  gateway.store.put("inbox", id, { id, input, state: "done" });
  gateway.store.put("platform-messages", `${entryKey(entry)}:source-a`, { sessionId: session.id });
  const edit = { ...input, eventId: "edit-a", eventType: "edit", text: "编辑后的正文" };
  gateway.store.put("inbox", inboxId(edit), { id: inboxId(edit), input: edit, state: "done" });
  gateway.store.put("message-changes", "change-a", { id: "change-a", input: edit, sessionId: session.id });
  gateway.store.put("channel-replies", "reply-a", { id: "reply-a", input, text: "已接受", status: "pending" });
  for (const collection of ["steering", "events", "approvals"]) gateway.store.put(collection, `${collection}:a`, { sessionId: session.id, status: "completed", text: input.text });
  gateway.store.put("defaults", entryKey(entry), { sessionId: session.id });
  gateway.store.put("defaults", "operator-selection", { sessionId: session.id });
  gateway.store.put("defaults", "survivor-selection", { sessionId: survivor.id });
  const survivorInput = { ...input, eventId: "request-b", messageId: "source-b", text: "保留会话的正文" };
  gateway.store.put("inbox", inboxId(survivorInput), { id: inboxId(survivorInput), sessionId: survivor.id, input: survivorInput, state: "done" });
  await gateway.manageSession(session, operator, "delete", true);
  assert.equal(gateway.store.get("sessions", session.id), undefined);
  assert.equal(gateway.store.get("tasks", taskId), undefined);
  for (const collection of ["messages", "tasks", "deliveries", "approvals", "events", "graphs", "coordination", "platform-messages", "steering", "message-changes", "channel-replies"]) assert.deepEqual(gateway.store.list(collection), [], collection);
  assert.equal(gateway.store.get("sequences", session.id), undefined);
  assert.deepEqual(gateway.store.entries("defaults"), [{ id: "survivor-selection", value: { sessionId: survivor.id } }]);
  assert.deepEqual(gateway.store.list("inbox").map(item => item.id), [inboxId(survivorInput)]);
  assert.deepEqual(gateway.store.get("receipts", channelReceiptId), { id: channelReceiptId, fingerprint: "retained-digest", error: "原请求所属会话已删除。" });
  await assert.rejects(gateway.handle(command, operator, request), /已删除/);
  assert.deepEqual(gateway.sessions(operator).map(item => item.id), [survivor.id]);
});
