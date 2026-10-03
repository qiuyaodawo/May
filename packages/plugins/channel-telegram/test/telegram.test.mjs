import assert from "node:assert/strict";
import test from "node:test";
import { inspectImage } from "@may/media";
import { telegramInput, telegramMemberInput, telegramDeliveryRouting, telegramImageRequest, TelegramAdapter } from "../dist/index.js";

test("Telegram message conversion retains platform routing and strips addressed mentions", () => {
  const input = telegramInput({ update_id: 33, message: { message_id: 89, message_thread_id: 14, from: { id: 991, is_bot: false }, chat: { id: -412, type: "supergroup" }, text: "@may Read documentation", entities: [{ type: "mention", offset: 0, length: 4 }], reply_to_message: { message_id: 88, from: { id: 271 } } } }, "telegram:271", "may");
  assert.equal(input.text, "Read documentation");
  assert.equal(input.mentioned, true); assert.equal(input.replyToBot, true);
  assert.deepEqual(telegramDeliveryRouting({ threadId: input.threadId, replyTo: input.replyTo }), { message_thread_id: 14, reply_parameters: { message_id: 88 } });
  assert.throws(() => telegramDeliveryRouting({ replyTo: "1.3" }), /Invalid/);
  const member = telegramMemberInput({ update_id: 34, chat_member: { chat: { id: -412, type: "supergroup" }, old_chat_member: { status: "member" }, new_chat_member: { status: "left", user: { id: 991, is_bot: false } } } }, "telegram:271");
  assert.equal(member.eventType, "member-left");
});

test("Telegram prepares an actual PNG upload and validates credential format", async () => {
  const image = await inspectImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfkAAAAASUVORK5CYII=", "base64"));
  const request = telegramImageRequest("991", image);
  assert.equal(request.method, "sendPhoto");
  assert.deepEqual(Buffer.from(await request.body.get("photo").arrayBuffer()), Buffer.from(image.data));
  assert.throws(() => new TelegramAdapter({ enabled: true, allowUsers: ["991"] }, "invalid-format"), /token format/);
});
