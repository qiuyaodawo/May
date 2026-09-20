import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { FileMediaStore, displayParts, readEmbeddedImage, imageAttachment } from "../dist/index.js";
import { imageSource } from "./fixture.mjs";

test("图片校验、稳定附件标识和文件保存", async () => {
  const source = await imageSource();
  const image = await readEmbeddedImage(source);
  assert.equal(image.width, 64); assert.equal(image.height, 32);
  const base = fileURLToPath(new URL("../../../review/media-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const store = new FileMediaStore(await mkdtemp(join(base, "files-")));
  const saved = await store.save(source);
  assert.deepEqual(await readFile(saved.path), Buffer.from(source.data, "base64"));
  assert.equal((await store.save(source)).path, saved.path);
  assert.equal((await store.verify(saved)).width, 64);
  const parts = displayParts([{ type: "text", text: "before" }, { type: "image", source }, { type: "text", text: "after" }]);
  assert.deepEqual(parts.map(part => part.type), ["text", "image", "text"]);
  assert.equal(JSON.stringify(parts).includes(source.data), false);
  await assert.rejects(readEmbeddedImage({ ...source, mediaType: "image/jpeg" }), /MIME/);
  await assert.rejects(readEmbeddedImage({ ...source, data: "invalid!" }), /base64/);
  assert.throws(() => imageAttachment({ type: "url", url: "file:///etc/passwd" }), /HTTP/);
  const avif = await sharp(image.data).avif().toBuffer();
  assert.equal((await readEmbeddedImage({ type: "base64", mediaType: "image/avif", data: avif.toString("base64") })).width, 64);
});
