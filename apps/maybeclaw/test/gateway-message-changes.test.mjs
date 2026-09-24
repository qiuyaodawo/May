import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { GatewayHost } from "../dist/gateway-host.js";
import { startGatewayServer } from "../dist/gateway-server.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { ChannelStore, inboxId } from "../dist/channel-store.js";
import { TelegramAdapter } from "../dist/channels.js";
import { actorKey, entryKey } from "../dist/gateway-types.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-message-change-tests/", import.meta.url));
const operator = { kind: "operator", id: "service-admin" };
const entry = { account: "telegram:42", conversation: "-100", kind: "group", threadId: "7" };
const actor = { kind: "platform", account: entry.account, conversation: entry.conversation, threadId: entry.threadId, userId: "123" };

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const password = randomBytes(32).toString("base64url");
  const config = { apps: { maybeclaw: { version: 2, server: { auth: { password } }, agents: [{ id: "code", adapter: "may" }] } } };
  const settings = gatewaySettings(config);
  await writeFile(join(directory, "may.config.json"), JSON.stringify(config));
  const gateway = new AgentGateway({ directory, configPath: join(directory, "may.config.json"), settings });
  const channels = await ChannelStore.open(join(directory, "gateway-channels.jsonl"));
  const adapter = new TelegramAdapter({ enabled: false, allowUsers: [], allowGroups: [entry.conversation] }, "42:configuration");
  const host = new GatewayHost({ gateway, adapters: [adapter] }, channels);
  const server = await startGatewayServer({ gateway, port: 0, close: () => host.close() });
  const loggedIn = await fetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(loggedIn.status, 200); const { token } = await loggedIn.json();
  const extraClosers = [];
  t.after(async () => {
    await server.close();
    for (const close of extraClosers) await close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, body) {
    const response = await fetch(new URL(path, server.url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { gateway, host, request, server, directory, settings, onClose: close => extraClosers.push(close) };
}

function dispatchedInput(gateway, session) {
  const input = { ...entry, sender: actor.userId, eventId: "original-event", messageId: "message-1", text: "  原执行输入\n第二行\n" };
  const message = gateway.record(session, { kind: "user", text: input.text, actor, sourceMessageId: input.messageId, sourceEntry: entryKey(entry) }, false);
  gateway.store.put("inbox", inboxId(input), { id: inboxId(input), input, sessionId: session.id, state: "done" });
  gateway.store.put("platform-messages", `${entryKey(entry)}:${input.messageId}`, { sessionId: session.id });
  return { input, message };
}

test("dispatched edits and recalls produce persistent notices visible through HTTP and history", async (t) => {
  const { gateway, host, request } = await fixture(t);
  const session = gateway.createSession(operator, "消息记录", ["code"], [], entry);
  const { input, message } = dispatchedInput(gateway, session);
  const text = '  编辑后的正文\n保留 "引号" 和空白\n';
  const edited = { ...input, eventId: "edited-event", eventType: "edit", text };
  const deleted = { ...input, eventId: "deleted-event", eventType: "delete", text: "" };
  await host.receive(edited);
  await host.receive(deleted);
  await host.receive(edited);
  assert.equal(gateway.store.get("messages", message.id).text, input.text);
  assert.equal(gateway.store.get("inbox", inboxId(input)).input.text, input.text);
  assert.deepEqual(gateway.store.list("tasks"), []);
  assert.deepEqual(gateway.store.list("graphs"), []);
  assert.deepEqual(gateway.store.list("deliveries"), []);
  const notices = gateway.messages(session.id, operator).filter(item => item.kind === "notice");
  assert.equal(notices.length, 2);
  assert.ok(notices[0].text.endsWith(text));
  assert.equal(gateway.store.get("message-changes", `${inboxId(edited)}:change`).input.text, text);
  assert.equal(gateway.store.get("message-changes", `${inboxId(edited)}:change`).noticeId, notices[0].id);
  assert.match(notices[1].text, /已撤回/);
  const snapshot = await request(`/api/ui/snapshot?selected=${session.id}`);
  assert.equal(snapshot.blocks.find(item => item.id === message.id).title, actorKey(actor));
  assert.deepEqual(snapshot.blocks.filter(item => item.kind === "notice").map(item => item.text), notices.map(item => item.text));
  const history = await request("/api/v2/commands", { text: "/history", sessionId: session.id, requestId: "history-notices" });
  assert.ok(history.output.text.includes(text));
  assert.ok(history.output.text.includes(input.text));
  assert.ok(history.output.text.includes(notices[1].text));
  await gateway.manageSession(session, operator, "delete", true);
  assert.deepEqual(gateway.store.list("message-changes"), []);
  assert.deepEqual(gateway.store.list("messages"), []);
  assert.deepEqual(gateway.store.list("inbox"), []);
});

test("a processing event obtains one notice when its original session becomes known", async (t) => {
  const { gateway, host } = await fixture(t);
  const session = gateway.createSession(operator, "处理期间编辑", ["code"], [], entry);
  const input = { ...entry, sender: actor.userId, eventId: "processing-input", messageId: "processing-message", text: "原始正文" };
  gateway.store.put("inbox", inboxId(input), { id: inboxId(input), input, state: "processing" });
  const edited = { ...input, eventId: "processing-edit", eventType: "edit", text: "处理中编辑" };
  await host.receive(edited);
  assert.deepEqual(gateway.messages(session.id, operator), []);
  gateway.recordChannelChange(edited, "processing", session.id);
  gateway.recordChannelChange(edited, "processing", session.id);
  assert.equal(gateway.messages(session.id, operator).length, 1);
  assert.equal(gateway.store.get("inbox", inboxId(input)).input.text, input.text);
  await assert.rejects(host.receive({ ...edited, text: "冲突事件正文" }), /内容冲突/);
});

test("platform edit deduplication remains effective after reopening SQLite and the Host", async (t) => {
  const { gateway, host, server, directory, settings, onClose } = await fixture(t);
  const session = gateway.createSession(operator, "持久编辑", ["code"], [], entry);
  const { input } = dispatchedInput(gateway, session);
  const edited = { ...input, eventId: "persisted-edit", eventType: "edit", text: "保存后的编辑正文" };
  await host.receive(edited);
  const messages = gateway.messages(session.id, operator);
  await server.close();
  const reopened = new AgentGateway({ directory, configPath: join(directory, "may.config.json"), settings });
  const channels = await ChannelStore.open(join(directory, "gateway-channels.jsonl"));
  const nextHost = new GatewayHost({ gateway: reopened, adapters: host.options.adapters }, channels);
  onClose(() => nextHost.close());
  await nextHost.receive(edited);
  assert.deepEqual(reopened.messages(session.id, operator), messages);
  assert.equal(reopened.store.list("message-changes").length, 1);
});

test("session selection reports active tasks and counts unsent logical messages once", async (t) => {
  const { gateway, request } = await fixture(t);
  const session = gateway.createSession(operator, "切换提示", ["code"], [], entry);
  for (const [id, status] of [["running", "running"], ["waiting", "waiting"], ["finished", "completed"]]) gateway.store.put("tasks", id, { id, sessionId: session.id, status });
  for (const [id, messageId, status] of [["part-1", "answer", "pending"], ["part-2", "answer", "pending"], ["failure", "another", "failed"], ["uncertain", "unknown-answer", "unknown"], ["sent", "delivered", "sent"]]) gateway.store.put("deliveries", id, { id, sessionId: session.id, messageId, status });
  const selection = await request("/api/v2/commands", { text: `/session select ${session.id}`, entry, requestId: "select-counts" });
  assert.match(selection.output.text, /进行中的任务：2/);
  assert.match(selection.output.text, /未发送消息：2/);
  assert.match(selection.output.text, /投递结果未确认：1/);
  assert.equal(gateway.store.get("defaults", entryKey(entry)).sessionId, session.id);
});
