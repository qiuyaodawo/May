import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { imageSource } from "../../../packages/media/test/fixture.mjs";
import { readEmbeddedImage } from "@may/media";
import { telegramImageRequest, feishuImageRequest } from "../dist/channels.js";
import { ChannelStore } from "../dist/channel-store.js";
import { digest } from "../dist/types.js";

test("渠道图片使用实际 multipart 文件和平台尺寸规则", async () => {
  const image = await readEmbeddedImage(await imageSource());
  const telegram = telegramImageRequest("123", image);
  assert.equal(telegram.method, "sendPhoto"); assert.equal(telegram.body.get("chat_id"), "123");
  assert.deepEqual(new Uint8Array(await telegram.body.get("photo").arrayBuffer()), new Uint8Array(image.data));
  const wide = await readEmbeddedImage(await imageSource(64, 1));
  assert.equal(telegramImageRequest("123", wide).method, "sendDocument");
  const feishu = await feishuImageRequest(image);
  assert.equal(feishu.get("image_type"), "message"); assert.equal(feishu.get("image").type, "image/png");
  assert.equal(feishu.get("image").size > 0, true);
});

test("附件投递引用和发送顺序经过持久存储恢复", async () => {
  const base = fileURLToPath(new URL("../../../review/media-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const path = join(await mkdtemp(join(base, "channels-")), "channels.jsonl");
  let store = await ChannelStore.open(path);
  const first = { kind: "delivery", id: digest("first"), account: "telegram:123", sender: "456", conversation: "456", text: "before", status: "sent" };
  const image = { ...first, id: digest("image"), text: "image", after: first.id, imageId: digest("source"), taskId: digest("task"), status: "sending" };
  await store.put(first); await store.put(image); await store.close();
  store = await ChannelStore.open(path);
  assert.equal(store.get(image.id).status, "unknown");
  assert.equal(store.get(image.id).imageId, image.imageId); assert.equal(store.get(image.id).after, first.id);
  await store.close();
});
