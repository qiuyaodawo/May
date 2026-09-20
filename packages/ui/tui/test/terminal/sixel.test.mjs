import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { FileMediaStore } from "@may/media";
import TerminalEvents from "tty-events";
import { imageSource } from "../../../../media/test/fixture.mjs";
import { multicolorImage } from "../fixtures/multicolor-image.mjs";
import { NodeTerminalDriver, TerminalImages, TerminalImageSupport, FullscreenRenderer, Stack, Text, createNodeTerminal, encodeImage } from "../../dist/index.js";

const require = createRequire(import.meta.url);

test("真实 xterm 终端查询、Sixel 显示、重绘、清除和 readline 输入", { timeout: 120_000 }, async t => {
  const base = fileURLToPath(new URL("../../../../../review/sixel-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "terminal-"));
  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR", "MAY_IMAGE_PROTOCOL"].map(key => [key, process.env[key]]));
  for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = directory;
  process.env.MAY_IMAGE_PROTOCOL = "sixel";
  const browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  let driver, readline;
  t.after(async () => {
    readline?.close(); driver?.close(); await browser.close();
    for (const [key, value] of Object.entries(variables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const page = await browser.newPage();
  await page.setContent('<div id="terminal"></div>');
  await page.addStyleTag({ path: require.resolve("@xterm/xterm/css/xterm.css") });
  await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
  await page.addScriptTag({ path: require.resolve("@xterm/addon-image") });
  const input = new PassThrough(), output = new PassThrough();
  // 流连接到真正运行的 xterm，所有查询响应由终端生成。
  Object.assign(output, { isTTY: true, columns: 80, rows: 30 });
  await page.exposeFunction("terminalData", data => {
    for (const byte of Buffer.from(data)) input.write(Buffer.from([byte]));
  });
  await page.evaluate(() => {
    window.term = new Terminal({ cols: 80, rows: 30, allowProposedApi: true });
    window.images = new ImageAddon.ImageAddon();
    window.term.loadAddon(window.images);
    window.term.open(document.getElementById("terminal"));
    window.deliveries = [];
    window.term.onData(data => window.deliveries.push(window.terminalData(data)));
  });
  let pending = Promise.resolve();
  output.on("data", data => {
    pending = pending.then(() => page.evaluate(async value => {
      await new Promise(resolve => window.term.write(value, resolve));
      await Promise.all(window.deliveries.splice(0));
    }, data.toString()));
  });
  const flush = async () => { let previous; do { previous = pending; await previous; } while (previous !== pending); };
  const detected = new TerminalImageSupport(output, false);
  const reportReader = new TerminalEvents(input, output, { timeout: 100 });
  reportReader.on("unknownSequence", sequence => detected.consume(sequence));
  t.after(() => { reportReader.pause(); reportReader.removeAllListeners(); });
  assert.equal(detected.cellSize, undefined);
  detected.query(); await flush();
  assert.ok(detected.cellSize);
  driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  const keys = [];
  driver.onKey(key => keys.push(key));
  driver.start(); driver.enterAlternateScreen();
  await flush();
  const cell = driver.imageSupport.cellSize;
  assert.ok(cell?.width > 0 && cell?.height > 0);
  assert.equal(keys.length, 0);
  const media = new FileMediaStore(join(directory, "media"));
  const images = new TerminalImages(media, "sixel", { cellSize: () => driver.imageSupport.cellSize });
  const source = await imageSource(1200, 600);
  await images.prepare([{ type: "image", source }]);
  const view = new Stack([new Text("before"), images.component(source), new Text("after")]);
  const renderer = new FullscreenRenderer(output);
  let frame = view.render(driver.size);
  const inspect = placement => page.evaluate(({ x, y }) => {
    const canvas = window.images.getImageAtBufferCell(x, y);
    return canvas ? { width: canvas.width, height: canvas.height, pixel: Array.from(canvas.getContext("2d").getImageData(0, 0, 1, 1).data) } : null;
  }, placement);
  renderer.render(frame, driver.size); await flush();
  const visible = await inspect(frame.images[0]);
  assert.ok(visible);
  assert.ok(visible.width <= frame.images[0].columns * cell.width);
  assert.ok(visible.height <= frame.images[0].rows * cell.height);
  assert.ok(Math.abs(visible.pixel[2] - 210) <= 5);
  assert.equal(await page.evaluate(() => window.term.buffer.active.getLine(0).translateToString(true)), "before");
  const pattern = await multicolorImage();
  await images.prepare([{ type: "image", source: pattern.source }]);
  const patterned = images.render(pattern.source, driver.size);
  renderer.render(patterned, driver.size); await flush();
  const pixels = await page.evaluate(({ x, y }) => {
    const canvas = window.images.getImageAtBufferCell(x, y);
    return { width: canvas.width, height: canvas.height, data: Array.from(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data) };
  }, patterned.images[0]);
  assert.deepEqual([pixels.width, pixels.height], [pattern.width, pattern.height]);
  for (let index = 0; index < pattern.pixels.length; index++) {
    assert.ok(Math.abs(pixels.data[index] - pattern.pixels[index]) <= 3, `pixel ${Math.floor(index / 4)}, channel ${index % 4}`);
  }
  // 图片位于屏幕底部时，不移动其他文字。
  const bottom = { ...frame.images[0], y: output.rows - frame.images[0].rows };
  renderer.render({ lines: ["top"], images: [bottom] }, driver.size); await flush();
  assert.ok(await inspect(bottom));
  assert.equal(await page.evaluate(() => window.term.buffer.active.getLine(0).translateToString(true)), "top");
  // 文字行更新会清除相应的图片单元格，需要重新绘制图片。
  renderer.render({ lines: ["top", ...Array.from({ length: bottom.y - 1 }, () => ""), "changed"], images: [bottom] }, driver.size);
  await flush(); assert.ok(await inspect(bottom));
  renderer.render({ lines: ["dialog"] }, driver.size); await flush();
  assert.equal(await inspect(bottom), null);
  await page.evaluate(() => { window.term.options.fontSize = 20; window.term.resize(40, 30); });
  Object.assign(output, { columns: 40 }); output.emit("resize"); await flush();
  assert.notDeepEqual(driver.imageSupport.cellSize, cell);
  frame = view.render(driver.size); renderer.render(frame, driver.size); await flush();
  assert.ok(await inspect(frame.images[0]));
  renderer.dispose(); await flush(); assert.equal(await inspect(frame.images[0]), null);
  driver.close(); await flush();
  readline = createNodeTerminal({ input, output });
  readline.imageSupport.query(); await flush(); await readline.imageSupport.ready();
  assert.deepEqual(readline.imageSupport.cellSize, driver.imageSupport.cellSize);
  const reply = readline.question("prompt> ");
  await flush();
  readline.imageSupport.query(); await flush();
  await page.evaluate(async () => { window.term.input("hello中文\r", true); await Promise.all(window.deliveries.splice(0)); });
  assert.equal(await reply, "hello中文");
  const placement = frame.images[0];
  readline.write("\n".repeat(placement.rows) + `\x1b[${placement.rows}A\x1b7` + encodeImage(placement) + `\x1b8\x1b[${placement.rows}B\rAfter image`);
  await flush();
  assert.ok(await page.evaluate(() => {
    for (let y = 0; y < window.term.buffer.active.length; y++) if (window.images.getImageAtBufferCell(0, y)) return true;
    return false;
  }));
  readline.close(); readline = undefined;
  await page.evaluate(() => {
    window.images.dispose();
    window.images = new ImageAddon.ImageAddon({ sixelSupport: false });
    window.term.loadAddon(window.images);
  });
  const unsupported = new TerminalImageSupport(output, false);
  reportReader.removeAllListeners();
  reportReader.on("unknownSequence", sequence => unsupported.consume(sequence));
  reportReader.resume();
  unsupported.query(); await flush(); await unsupported.ready();
  assert.equal(unsupported.cellSize, undefined);
});
