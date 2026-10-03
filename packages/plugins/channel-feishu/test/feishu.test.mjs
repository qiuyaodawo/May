import assert from "node:assert/strict";
import test from "node:test";
import { inspectImage } from "@may/media";
import { feishuInput, feishuMemberInputs, feishuRecallInput, feishuDeliveryRequest, feishuImageRequest, FeishuAdapter } from "../dist/index.js";

test("Feishu message, recall and membership conversion retain original identities", () => {
  const input = feishuInput({ event_id: "ev_document", sender: { sender_type: "user", sender_id: { open_id: "ou_reader" } }, message: { message_id: "om_document", chat_id: "oc_readers", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 Read documentation" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }], thread_id: "omt_thread", parent_id: "om_parent" } }, "feishu:cli_document", "ou_bot");
  assert.equal(input.text, "Read documentation"); assert.equal(input.mentioned, true);
  assert.equal(feishuRecallInput({ event_id: "ev_recall", message_id: input.messageId, chat_id: input.conversation }, input).eventType, "delete");
  const members = feishuMemberInputs({ event_id: "ev_member", chat_id: "oc_readers", users: [{ user_id: { open_id: "ou_reader" } }, { user_id: { open_id: "ou_reader" } }] }, input.account, true);
  assert.equal(members.length, 1); assert.equal(members[0].eventType, "member-joined");
  const delivery = feishuDeliveryRequest({ id: "document", conversation: input.conversation, text: input.text, threadId: input.threadId, replyTo: input.replyTo });
  assert.equal(delivery.path, "/im/v1/messages/om_parent/reply"); assert.equal(delivery.body.reply_in_thread, true);
  assert.throws(() => feishuDeliveryRequest({ id: "document", conversation: input.conversation, text: input.text, threadId: input.threadId }), /requires a reply/);
});

test("Feishu PNG upload uses actual image decoding and validates credential format", async () => {
  const image = await inspectImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfkAAAAASUVORK5CYII=", "base64"));
  const form = await feishuImageRequest(image);
  assert.equal(form.get("image_type"), "message");
  const uploaded = await inspectImage(new Uint8Array(await form.get("image").arrayBuffer()));
  assert.equal(uploaded.mediaType, "image/png"); assert.equal(uploaded.width, image.width);
  assert.throws(() => new FeishuAdapter({ enabled: true, appId: "invalid-format", allowUsers: [] }, ""), /credentials/);
});
