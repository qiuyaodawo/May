import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { telegramInput, telegramMemberInput, feishuInput, feishuMemberInputs, feishuRecallInput, channelAccepts, channelTrigger, telegramDeliveryRouting, feishuDeliveryRequest } from "../dist/channels.js";
import { ChannelStore, inboxId, validateChannelInput } from "../dist/channel-store.js";
import { hostSettings } from "../dist/settings.js";
import { digest } from "../dist/types.js";

const telegramMessage = { message_id: 45, message_thread_id: 12, date: 1_790_000_000, from: { id: 7, is_bot: false }, chat: { id: -10012, type: "supergroup" }, text: "@maybeclaw /session 项目 检查修改", entities: [{ type: "mention", offset: 0, length: 10 }], reply_to_message: { message_id: 42, from: { id: 88, is_bot: true } } };
const feishuEvent = { event_id: "event_45", sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: { chat_type: "group", chat_id: "oc_project", message_id: "om_45", parent_id: "om_42", thread_id: "omt_topic", message_type: "text", content: JSON.stringify({ text: "@_user_1 /session 项目 检查修改" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } };

test("平台成员事件使用受影响成员身份，并覆盖群聊全部话题", () => {
  const user = { id: 7, is_bot: false };
  const update = { update_id: 1000, chat_member: { chat: { id: -10012, type: "supergroup" }, date: 1_790_000_000,
    from: { id: 99, is_bot: false }, old_chat_member: { status: "member", user }, new_chat_member: { status: "left", user } } };
  const left = telegramMemberInput(update, "telegram:88");
  validateChannelInput(left);
  assert.equal(left.eventType, "member-left");
  assert.equal(left.sender, "7");
  assert.equal(left.threadId, undefined);
  assert.equal(left.occurredAt, "1790000000000");
  const joined = telegramMemberInput({ ...update, update_id: 1001, chat_member: { ...update.chat_member, old_chat_member: { status: "restricted", is_member: false, user }, new_chat_member: { status: "restricted", is_member: true, user } } }, left.account);
  validateChannelInput(joined);
  assert.equal(joined.eventType, "member-joined");
  assert.equal(telegramMemberInput({ ...update, chat_member: { ...update.chat_member, new_chat_member: { status: "administrator", user } } }, left.account), undefined);
  assert.equal(telegramMemberInput({ ...update, chat_member: { ...update.chat_member, new_chat_member: { status: "left", user: { id: 88, is_bot: true } } } }, left.account), undefined);
  const event = { event_id: "members", chat_id: "oc_project", create_time: "1790000000000", users: [{ user_id: { open_id: "ou_alice" } }, { user_id: { open_id: "ou_bob" } }] };
  const members = feishuMemberInputs(event, "feishu:cli_project", false);
  members.forEach(validateChannelInput);
  assert.deepEqual(members.map(value => value.sender), ["ou_alice", "ou_bob"]);
  assert.equal(new Set(members.map(inboxId)).size, 2);
  assert.deepEqual(feishuMemberInputs(event, "feishu:cli_project", false), members);
  assert.throws(() => feishuMemberInputs({ ...event, users: [{ user_id: { user_id: "other_id" } }] }, "feishu:cli_project", true), /open_id/);
  assert.throws(() => validateChannelInput({ ...left, kind: "private" }), /group entrance/);
});

test("Telegram 群聊和话题消息保留作者、回复和编辑事件", () => {
  const input = telegramInput({ update_id: 901, message: telegramMessage }, "telegram:88", "MaybeClaw");
  validateChannelInput(input);
  assert.equal(input.kind, "group");
  assert.equal(input.threadId, "12");
  assert.equal(input.messageId, "45");
  assert.equal(input.replyTo, "42");
  assert.equal(input.replyToBot, true);
  assert.equal(input.mentioned, true);
  assert.equal(input.sender, "7");
  assert.equal(input.text, "/session 项目 检查修改");
  const edited = telegramInput({ update_id: 902, edited_message: { ...telegramMessage, text: "检查错误处理", entities: [], edit_date: 1_790_000_001 } }, "telegram:88", "MaybeClaw");
  assert.equal(edited.eventType, "edit");
  assert.equal(edited.messageId, input.messageId);
  assert.notEqual(inboxId(edited), inboxId(input));
  assert.equal(telegramInput({ update_id: 903, message: { ...telegramMessage, from: { id: 88, is_bot: true } } }, "telegram:88"), undefined);
  assert.equal(telegramInput({ update_id: 904, message: { ...telegramMessage, sender_chat: { id: -10012 } } }, "telegram:88"), undefined);
  const directed = telegramInput({ update_id: 905, message: { ...telegramMessage, text: "/session@MaybeClaw list", entities: [] } }, "telegram:88", "maybeclaw");
  assert.equal(directed.text, "/session list");
  assert.equal(telegramInput({ update_id: 906, message: { ...telegramMessage, text: "@other_bot hi", entities: [{ type: "mention", offset: 0, length: 10 }] } }, "telegram:88", "maybeclaw").mentioned, false);
});

test("飞书消息保留线程和附件，撤回只关联已记录的来源消息", () => {
  const input = feishuInput(feishuEvent, "feishu:cli_project", "ou_bot");
  validateChannelInput(input);
  assert.equal(input.kind, "group");
  assert.equal(input.threadId, "omt_topic");
  assert.equal(input.replyTo, "om_42");
  assert.equal(input.text, "/session 项目 检查修改");
  assert.equal(input.mentioned, true);
  assert.equal(feishuInput(feishuEvent, "feishu:cli_project", "ou_other").mentioned, false);
  const file = feishuInput({ ...feishuEvent, message: { ...feishuEvent.message, message_type: "file", content: JSON.stringify({ file_key: "file_key", file_name: "review.md", file_size: 200 }) } }, input.account);
  validateChannelInput(file);
  assert.equal(file.attachments[0].kind, "file");
  assert.equal(file.attachments[0].name, "review.md");
  assert.equal(file.attachments[0].source.messageId, "om_45");
  const deletion = feishuRecallInput({ event_id: "recall_45", message_id: "om_45", chat_id: "oc_project", recall_time: "1790000001000" }, file);
  validateChannelInput(deletion);
  assert.equal(deletion.eventType, "delete");
  assert.equal(deletion.sender, file.sender);
  assert.equal(deletion.text, "");
  assert.deepEqual(deletion.attachments, []);
  assert.throws(() => feishuRecallInput({ event_id: "recall_45", message_id: "om_45", chat_id: "oc_other" }, file), /does not match/);
});

test("附件输入保留完整文件信息，并检查持久记录格式", () => {
  const image = telegramInput({ update_id: 907, message: { ...telegramMessage, text: undefined, entities: [], caption: "检查图片", photo: [{ file_id: "small", file_unique_id: "small_unique", file_size: 20 }, { file_id: "large", file_unique_id: "large_unique", file_size: 200 }] } }, "telegram:88");
  validateChannelInput(image);
  assert.equal(image.attachments.length, 1);
  assert.equal(image.attachments[0].source.fileId, "large");
  assert.equal(image.attachments[0].mediaType, "image/jpeg");
  const imageOnly = telegramInput({ update_id: 908, message: { ...telegramMessage, text: undefined, entities: [], document: { file_id: "document", file_name: "README.md", mime_type: "text/markdown", file_size: 100 } } }, "telegram:88");
  validateChannelInput(imageOnly);
  assert.equal(imageOnly.text, "");
  assert.throws(() => validateChannelInput({ ...imageOnly, attachments: [{ ...imageOnly.attachments[0], size: -1 }] }), /size/);
  assert.throws(() => validateChannelInput({ ...imageOnly, attachments: [] }), /text/);
  assert.throws(() => validateChannelInput({ ...imageOnly, eventType: "delete", messageId: undefined }), /message ID/);
});

test("渠道访问和群聊触发配置独立检查", () => {
  const channels = { telegram: { enabled: true, allowUsers: ["7"], allowGroups: ["-10012"], groupTrigger: "explicit", entranceTriggers: [{ conversation: "-10012", threadId: "12", trigger: "all" }] } };
  const settings = hostSettings({ apps: { maybeclaw: { channels, agents: [], access: {} } } }).telegram;
  assert.equal(channelAccepts(settings, { kind: "private", sender: "7", conversation: "7" }), true);
  assert.equal(channelAccepts(settings, { kind: "private", sender: "8", conversation: "8" }), false);
  assert.equal(channelAccepts(settings, { kind: "group", sender: "8", conversation: "-10012" }), true);
  assert.equal(channelAccepts(settings, { kind: "group", sender: "7", conversation: "-10013" }), false);
  assert.equal(channelTrigger(settings, { conversation: "-10012", threadId: "12" }), "all");
  assert.equal(channelTrigger(settings, { conversation: "-10012", threadId: "13" }), "explicit");
  assert.equal(hostSettings({ apps: { maybeclaw: { channels: { telegram: { enabled: true, allowGroups: ["-10012"] } } } } }).telegram.allowUsers.length, 0);
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { telegram: { enabled: true, allowUsers: [] } } } } }), /allowUsers or allowGroups/);
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { telegram: { ...channels.telegram, allowGroups: true } } } } }), /allowGroups/);
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { telegram: { ...channels.telegram, groupTrigger: "typo" } } } } }), /groupTrigger/);
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { telegram: { ...channels.telegram, entranceTriggers: [{ conversation: "-10013", trigger: "all" }] } } } } }), /entrance trigger/);
});

test("原生回复请求保持消息和话题目标", () => {
  assert.deepEqual(telegramDeliveryRouting({ threadId: "12", replyTo: "45" }), { message_thread_id: 12, reply_parameters: { message_id: 45 } });
  assert.throws(() => telegramDeliveryRouting({ replyTo: "0" }), /Invalid Telegram/);
  assert.throws(() => telegramDeliveryRouting({ threadId: "9007199254740993" }), /Invalid Telegram/);
  const delivery = { id: digest("reply"), conversation: "oc_project", text: "检查完成", threadId: "omt_topic", replyTo: "om_45" };
  const reply = feishuDeliveryRequest(delivery);
  assert.equal(reply.path, "/im/v1/messages/om_45/reply");
  assert.equal(reply.body.reply_in_thread, true);
  assert.equal(reply.body.receive_id, undefined);
  assert.equal(JSON.parse(reply.body.content).text, "检查完成");
  assert.throws(() => feishuDeliveryRequest({ ...delivery, replyTo: undefined }), /reply message ID/);
  const direct = feishuDeliveryRequest({ ...delivery, threadId: undefined, replyTo: undefined });
  assert.equal(direct.body.receive_id, "oc_project");
});

test("渠道记录重启保留来源和发送回执，只读检查不改变未知发送", async t => {
  const base = fileURLToPath(new URL("../../../.zcode/tmp/channel-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway-channels.jsonl");
  let store = await ChannelStore.open(path);
  const input = telegramInput({ update_id: 901, message: telegramMessage }, "telegram:88", "maybeclaw");
  await store.put({ kind: "inbox", id: inboxId(input), input, processed: false });
  const delivery = { kind: "delivery", id: digest("delivery"), account: input.account, sender: input.sender, conversation: input.conversation, conversationKind: "group", threadId: input.threadId, replyTo: input.messageId, messageId: "48", text: "完成", status: "sending" };
  await store.put(delivery);
  await store.close();
  const original = await readFile(path);
  assert.equal((await ChannelStore.inspect(path)).find(value => value.id === delivery.id).status, "sending");
  assert.deepEqual(await readFile(path), original);
  store = await ChannelStore.open(path);
  assert.equal(store.get(delivery.id).status, "unknown");
  assert.equal(store.get(delivery.id).messageId, "48");
  assert.deepEqual(store.get(inboxId(input)).input, input);
  await store.close();
  await writeFile(join(directory, "gateway.format.json"), JSON.stringify({ version: 1 }));
  await assert.rejects(ChannelStore.open(join(directory, "channels.jsonl")), /read-only/);
  store = await ChannelStore.open(path);
  await store.close();
});
