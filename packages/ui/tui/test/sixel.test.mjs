import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import AnsiParser from "node-ansiparser";
import { Decoder } from "sixel";
import { Jimp } from "jimp";
import { FileMediaStore } from "@may/media";
import { imageSource } from "../../../media/test/fixture.mjs";
import { multicolorImage } from "./fixtures/multicolor-image.mjs";
import { TerminalImages, encodeImage, Stack, ScrollView, Text, TranscriptStore, TranscriptView } from "../dist/index.js";

function decodeFrame(frame) {
  const decoder = new Decoder({ memoryLimit: 8 * 1024 * 1024 });
  const parser = new AnsiParser({
    inst_H(_collected, _params, flag) { assert.equal(flag, "q"); decoder.init(); },
    inst_P(data) { decoder.decodeString(data); },
    inst_U() {},
  });
  parser.parse(encodeImage(frame));
  return { width: decoder.width, height: decoder.height, data: Buffer.from(decoder.data8) };
}

async function mediaStore() {
  const base = fileURLToPath(new URL("../../../../review/sixel-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  return new FileMediaStore(await mkdtemp(join(base, "images-")));
}

test("Sixel 编码保持像素、图文顺序，并按字符尺寸缩放", async () => {
  const media = await mediaStore();
  let cell = { width: 10, height: 20 };
  const images = new TerminalImages(media, "sixel", { cellSize: () => cell });
  const source = await imageSource(1200, 600);
  await images.prepare([{ type: "image", source }]);
  const view = new Stack([new Text("before"), images.component(source), new Text("after")]);
  const frame = view.render({ width: 80, height: 40 });
  const placement = frame.images[0];
  const decoded = decodeFrame(placement);
  assert.deepEqual([decoded.width, decoded.height], [480, 240]);
  assert.equal(placement.rows, 12);
  assert.ok(frame.lines.indexOf("after") >= placement.y + placement.rows);
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    for (const [channel, expected] of [32, 120, 210, 255].entries()) assert.ok(Math.abs(decoded.data[offset + channel] - expected) <= 5);
  }
  const narrow = images.render(source, { width: 15, height: 40 }).images[0];
  const small = decodeFrame(narrow);
  assert.deepEqual([small.width, small.height], [150, 75]);
  assert.ok(small.width <= narrow.columns * cell.width);
  assert.ok(Math.ceil(small.height / 6) * 6 <= narrow.rows * cell.height);
  assert.equal(new ScrollView(view).render({ width: 80, height: 5 }).images?.length ?? 0, 0);
  const store = new TranscriptStore();
  const message = { role: "assistant", content: [{ type: "image", source }] };
  store.applyMayEvent({ type: "model.completed", seq: 1, runId: "sixel", step: 1, timestamp: 1, message });
  const transcript = new TranscriptView(store, { images });
  const first = transcript.renderTail({ width: 80, height: 40 });
  cell = { width: 8, height: 16 };
  const changed = transcript.renderTail({ width: 80, height: 40 });
  assert.notEqual(first.images[0].sixel, changed.images[0].sixel);
  assert.deepEqual([decodeFrame(changed.images[0]).width, decodeFrame(changed.images[0]).height], [384, 192]);
  cell = undefined;
  assert.equal(transcript.renderTail({ width: 80, height: 40 }).images?.length ?? 0, 0);
});

test("透明图片使用白色预览背景，并完整保存原始文件", async () => {
  const png = await new Jimp({ width: 18, height: 12, color: 0xff000080 }).getBuffer("image/png");
  const source = { type: "base64", mediaType: "image/png", data: png.toString("base64") };
  const media = await mediaStore();
  const images = new TerminalImages(media, "sixel", { cellSize: () => ({ width: 10, height: 20 }) });
  await images.prepare([{ type: "image", source }]);
  const decoded = decodeFrame(images.render(source, { width: 80, height: 30 }).images[0]);
  assert.ok(decoded.data[0] >= 250);
  assert.ok(Math.abs(decoded.data[1] - 127) <= 5);
  assert.ok(Math.abs(decoded.data[2] - 127) <= 5);
  assert.equal(decoded.data[3], 255);
  assert.deepEqual(await readFile((await media.save(source)).path), png);
});

test("多色图片在编码、缓存和尺寸变化后保持逐像素位置", async () => {
  const media = await mediaStore();
  const images = new TerminalImages(media, "sixel", { cellSize: () => ({ width: 10, height: 20 }) });
  for (const [width, height] of [[61, 37], [7, 5]]) {
    const fixture = await multicolorImage(width, height);
    await images.prepare([{ type: "image", source: fixture.source }]);
    const first = images.render(fixture.source, { width: 80, height: 30 }).images[0];
    assert.equal(images.render(fixture.source, { width: 80, height: 30 }).images[0].sixel, first.sixel);
    images.render(fixture.source, { width: 3, height: 100 });
    const restored = images.render(fixture.source, { width: 80, height: 30 }).images[0];
    assert.equal(restored.sixel, first.sixel);
    const decoded = decodeFrame(restored);
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    for (let index = 0; index < fixture.pixels.length; index++) {
      assert.ok(Math.abs(decoded.data[index] - fixture.pixels[index]) <= 3, `${width}x${height}: pixel ${Math.floor(index / 4)}, channel ${index % 4}: ${decoded.data[index]} expected ${fixture.pixels[index]}`);
    }
    assert.deepEqual(await readFile((await media.save(fixture.source)).path), Buffer.from(fixture.source.data, "base64"));
  }
});
