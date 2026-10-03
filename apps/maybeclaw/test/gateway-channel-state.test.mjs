import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { AgentGateway } from "../dist/gateway.js";
import { GatewayHost } from "../dist/gateway-host.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { ChannelStore, inboxId } from "../dist/channel-store.js";
import { TelegramAdapter, telegramMemberInput } from "../dist/channels.js";
import { createTelegramChannelPlugin } from "@may/plugin-channel-telegram";
import { digest } from "../dist/types.js";
import { setTimeout as delay } from "node:timers/promises";

const base = fileURLToPath(new URL("../../../.zcode/tmp/gateway-channel-state/", import.meta.url));
const operator = { kind: "operator", id: "admin" };
const input = { account: "telegram:42", sender: "7", conversation: "7", kind: "private", eventId: "100", messageId: "1", text: "原始问题" };
async function setup(t) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "state-"));
  const settings = gatewaySettings({ apps: { maybeclaw: { version: 2, agents: [{ id: "reader", adapter: "may" }] } } });
  const gateway = new AgentGateway({ directory, settings, configPath: join(directory, "config.json") });
  t.after(async () => { await gateway.close(); assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { gateway, directory };
}

test("尚未派发的消息接受编辑后，原事件重传仍按初始摘要去重", async t => {
  const { gateway, directory } = await setup(t);
  const adapter = new TelegramAdapter({ enabled: false, allowUsers: ["7"] }, "42:configuration");
  const host = await GatewayHost.start({ gateway, adapters: [adapter], startPaused: true });
  t.after(() => host.close());
  await host.receive(input);
  await host.receive({ ...input, eventId: "101", eventType: "edit", text: "更新的问题" });
  await host.receive(input);
  assert.equal(gateway.store.get("inbox", inboxId(input)).input.text, "更新的问题");
  assert.equal(gateway.store.get("inbox", inboxId(input)).fingerprint, digest(input));
  await assert.rejects(host.receive({ ...input, text: "其他内容" }), /内容冲突/);
  assert.equal((await ChannelStore.inspect(join(directory, "gateway-channels.jsonl"))).some(record => record.kind === "inbox"), false);
  await host.close();
});

test("重启将发送中的通知记为unknown，并移除旧正文镜像", async t => {
  const { gateway, directory } = await setup(t);
  const path = join(directory, "gateway-channels.jsonl");
  const channels = await ChannelStore.open(path);
  await channels.put({ kind: "inbox", id: inboxId(input), input, processed: true });
  await channels.close();
  const id = digest("reply");
  gateway.store.put("channel-replies", id, { id, input, text: "通知正文", status: "sending" });
  const legacyId = digest("legacy");
  gateway.store.put("legacy-deliveries", legacyId, { kind: "delivery", id: legacyId, account: input.account, sender: input.sender, conversation: input.conversation, text: "历史回复", status: "sending" });
  const host = await GatewayHost.start({ gateway, adapters: [] });
  t.after(() => host.close());
  assert.equal(host.status().channelReplies[0].status, "unknown");
  assert.equal(host.status().legacyDeliveries[0].status, "unknown");
  assert.doesNotMatch(await readFile(path, "utf8"), /原始问题/);
  assert.throws(() => host.retryLegacyDelivery(legacyId, operator), /确认可能重复/);
  assert.throws(() => host.retryLegacyDelivery(legacyId, { kind: "platform", account: input.account, conversation: input.conversation, userId: input.sender }, true), /服务管理员/);
  assert.equal(host.retryLegacyDelivery(legacyId, operator, true).status, "pending");
  await host.deliver();
  assert.equal(host.status().legacyDeliveries[0].status, "pending");
  await host.close();
});

test("后台处理遇到无效持久事件时停止调度，并在服务状态显示错误", async t => {
  const { gateway } = await setup(t);
  const host = await GatewayHost.start({ gateway, adapters: [] });
  t.after(() => host.close());
  const event = { ...input, kind: "group", eventType: "member-left", eventId: "invalid-time", occurredAt: "invalid" };
  gateway.store.put("inbox", inboxId(event), { id: inboxId(event), input: event, state: "pending" });
  for (let attempt = 0; attempt < 100 && host.status().state !== "degraded"; attempt++) await delay(10);
  assert.equal(host.status().state, "degraded");
  assert.match(host.status().error, /成员事件时间无效/);
  assert.equal(gateway.store.get("inbox", inboxId(event)).state, "pending");
  await host.close();
});

test("会话结果分页保留Unicode，并明确说明渠道未发送的附件", async t => {
  const { gateway } = await setup(t);
  const session = gateway.createSession(operator, "项目", ["reader"], [], { account: input.account, conversation: input.conversation, kind: "private", owner: input.sender });
  const text = "x".repeat(2967) + "🙂" + "后续内容".repeat(1000);
  const message = gateway.record(session, { kind: "assistant", text, agentId: "reader", content: [{ type: "file", name: "result.txt", source: { type: "base64", mediaType: "text/plain", data: Buffer.from("文件内容").toString("base64") } }] });
  const deliveries = gateway.store.list("deliveries").filter(value => value.messageId === message.id);
  assert.ok(deliveries.length > 1);
  assert.ok(deliveries.every(value => value.text.length <= 4096));
  assert.ok(deliveries.every(value => !/[\uD800-\uDBFF]$/u.test(value.text)));
  assert.ok(deliveries.at(-1).text.includes("file"));
  assert.ok(deliveries.at(-1).text.includes("会话历史"));
  for (let index = 1; index < deliveries.length; index++) assert.equal(deliveries[index].after, deliveries[index - 1].id);
});

test("成员事件经Host持久处理后撤销群内全部话题访问，并忽略较早的加入事件", async t => {
  const { gateway } = await setup(t);
  const adapter = new TelegramAdapter({ enabled: false, allowUsers: [], allowGroups: ["-10012"] }, "42:configuration");
  const host = await GatewayHost.start({ gateway, adapters: [adapter], startPaused: true });
  t.after(() => host.close());
  const entry = { account: adapter.account, conversation: "-10012", kind: "group", threadId: "12" };
  const session = gateway.createSession(operator, "群聊话题", ["reader"], [], entry);
  const actor = { kind: "platform", account: adapter.account, conversation: entry.conversation, userId: "7", threadId: "12" };
  const user = { id: 7, is_bot: false };
  const event = { update_id: 1000, chat_member: { chat: { id: -10012, type: "supergroup" }, date: 1_790_000_000, old_chat_member: { status: "member", user }, new_chat_member: { status: "left", user } } };
  const left = telegramMemberInput(event, adapter.account);
  await host.receive(left);
  await host.tick();
  assert.equal(gateway.canAccess(session, actor), false);
  assert.equal(gateway.store.get("inbox", inboxId(left)).state, "done");
  const joined = { ...left, eventId: "1001", eventType: "member-joined", occurredAt: "1789999999000" };
  await host.receive(joined);
  await host.tick();
  assert.equal(gateway.canAccess(session, actor), false);
  await host.receive({ ...joined, eventId: "1002", occurredAt: "1790000001000" });
  await host.tick();
  assert.equal(gateway.canAccess(session, actor), true);
  assert.equal(gateway.store.list("channel-replies").length, 0);
  await host.close();
});

test("渠道删除会话保留操作回执并清除原输入记录", async t => {
  const { gateway } = await setup(t);
  const adapters = [new TelegramAdapter({ enabled: false, allowUsers: ["7"] }, "42:configuration")];
  const host = await GatewayHost.start({ gateway, adapters, startPaused: true });
  t.after(() => host.close());
  const session = gateway.createSession(operator, "待删除", ["reader"], [], { account: input.account, conversation: input.conversation, kind: "private", owner: input.sender });
  const command = { ...input, eventId: "delete", text: `/session delete ${session.id} --confirm` };
  await host.receive(command);
  await host.tick();
  assert.equal(gateway.store.get("sessions", session.id), undefined);
  assert.equal(gateway.store.get("inbox", inboxId(command)), undefined);
  const replies = gateway.store.list("channel-replies");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].input.text, "");
  assert.equal(replies[0].sessionId, undefined);
  assert.match(replies[0].text, /操作已完成/);
  assert.equal(replies[0].status, "pending");
  assert.equal(host.status().channels.length, 1);
  await host.close();
});

for (const includeAdapter of [false, true]) test(`渠道插件与 adapters 共同注册并接收消息：${includeAdapter ? "具有额外渠道" : "空数组"}`, async t => {
  const { gateway } = await setup(t);
  const adapters = includeAdapter ? [new TelegramAdapter({ enabled: false, allowUsers: ["7"] }, "43:configuration")] : [];
  const host = await GatewayHost.start({ gateway, adapters, plugins: [createTelegramChannelPlugin({
    settings: { enabled: false, allowUsers: ["7"] }, token: "42:configuration",
  })], startPaused: true });
  t.after(() => host.close());
  assert.deepEqual(host.status().channels.map(channel => channel.account).sort(), includeAdapter ? ["telegram:42", "telegram:43"] : ["telegram:42"]);
  for (const account of host.status().channels.map(channel => channel.account)) {
    const event = { ...input, account, eventId: `status:${account}`, text: "/status" };
    await host.receive(event);
    assert.equal(gateway.store.get("inbox", inboxId(event)).state, "pending");
  }
  await host.tick();
  assert.equal(gateway.store.list("channel-replies").length, includeAdapter ? 2 : 1);
  assert.ok(gateway.store.list("channel-replies").every(reply => reply.status === "pending"));
  await host.close();
});
