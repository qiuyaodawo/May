import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSource } from "../../../packages/media/test/fixture.mjs";
import { readEmbeddedImage } from "@may/media";
import { channelAttachmentContent, readChannelContent, channelTextPages, channelEntry } from "../dist/gateway-host.js";
import { createMayAdapter } from "../dist/gateway-adapters.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { TelegramAdapter } from "../dist/channels.js";

test("视频输入需要独立的Agent媒体能力配置", async () => {
  const config = media => ({ apps: { maybeclaw: { version: 2, agents: [{ id: "media", adapter: "may", media }] } } });
  const settings = gatewaySettings(config(["image", "audio", "file", "video"]));
  const agent = createMayAdapter({ directory: ".zcode/tmp/gateway-channel-media", configPath: ".zcode/tmp/gateway-channel-media/config.json", agent: settings.agents[0] });
  assert.deepEqual(agent.capabilities.media, ["image", "audio", "file", "video"]);
  assert.throws(() => gatewaySettings(config(["video", "video"])), /media/);
  assert.throws(() => gatewaySettings(config(["unknown"])), /media/);
  const adapter = new TelegramAdapter({ enabled: false, allowUsers: ["7"] }, "42:configuration");
  const attachment = { id: "video_1", kind: "video", mediaType: "video/mp4", source: { platform: "telegram", fileId: "video_1" } };
  await assert.rejects(readChannelContent(adapter, { account: adapter.account, sender: "7", conversation: "7", text: "检查视频", eventId: "video", attachments: [attachment] },
    [{ ...agent.capabilities, media: ["file"] }], new AbortController().signal), /不支持 video/);
  const schema = JSON.parse(await readFile(new URL("../../../packages/config/may-config.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.$defs.maybeclawAgent.properties.media.items.enum, ["image", "audio", "file", "video"]);
  await agent.close();
});

test("文件附件的实际字节和名称进入UserMessage媒体内容", async t => {
  const base = fileURLToPath(new URL("../../../.zcode/tmp/gateway-channel-media/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "修改说明.md"), text = "# 修改说明\n检查错误处理。\n";
  await writeFile(path, text);
  const bytes = await readFile(path);
  const attachment = { id: "file_1", kind: "file", name: "修改说明.md", mediaType: "text/markdown", size: bytes.length, source: { platform: "telegram", fileId: "file_1" } };
  const part = await channelAttachmentContent(attachment, { data: bytes }, 1024);
  assert.equal(part.type, "file");
  assert.equal(part.name, "修改说明.md");
  assert.equal(part.source.mediaType, "text/markdown");
  assert.equal(Buffer.from(part.source.data, "base64").toString("utf8"), text);
  await assert.rejects(channelAttachmentContent(attachment, { data: bytes }, bytes.length - 1), /大小限制/);
  await assert.rejects(channelAttachmentContent({ ...attachment, kind: "unsupported" }, { data: bytes }, 1024), /附件类型/);
});

test("图片附件通过实际解码确定内容类型并拒绝损坏数据", async () => {
  const source = await imageSource(8, 8), image = await readEmbeddedImage(source);
  const attachment = { id: "image_1", kind: "image", mediaType: "application/octet-stream", source: { platform: "feishu", fileId: "image_1", messageId: "om_1" } };
  const part = await channelAttachmentContent(attachment, { data: image.data }, 1024 * 1024);
  assert.equal(part.type, "image");
  assert.equal(part.source.mediaType, image.mediaType);
  assert.deepEqual((await readEmbeddedImage(part.source)).data, image.data);
  await assert.rejects(channelAttachmentContent(attachment, { data: Buffer.from("invalid image") }, 1024));
});

test("长消息完整分页保留Unicode内容和平台入口", () => {
  const text = "检查🧑‍💻修改\n".repeat(1200);
  const pages = channelTextPages(text, 512);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 512));
  assert.equal(pages.map(page => page.slice(page.indexOf("\n") + 1)).join(""), text);
  assert.ok(pages.every(page => !/[\uD800-\uDBFF]$/u.test(page)));
  assert.deepEqual(channelEntry({ account: "telegram:42", conversation: "-100", kind: "group", threadId: "12", sender: "7" }), { account: "telegram:42", conversation: "-100", kind: "group", threadId: "12" });
  assert.deepEqual(channelTextPages("完整回复", 4096), ["完整回复"]);
});
