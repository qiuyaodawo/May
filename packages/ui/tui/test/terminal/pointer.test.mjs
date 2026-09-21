import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { NodeTerminalDriver } from "../../dist/index.js";

const require = createRequire(import.meta.url);

test("真实 xterm 鼠标拖动和 End 按键进入终端驱动", { timeout: 60_000 }, async t => {
  const base = fileURLToPath(new URL("../../../../../review/pointer-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "terminal-"));
  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(variables)) process.env[key] = directory;
  const browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const input = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  t.after(async () => {
    output.removeAllListeners("data");
    driver.close();
    await browser.close();
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const page = await browser.newPage();
  await page.setContent('<div id="terminal"></div>');
  await page.addStyleTag({ path: require.resolve("@xterm/xterm/css/xterm.css") });
  await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
  await page.exposeFunction("terminalData", value => input.write(value));
  await page.evaluate(() => {
    window.term = new Terminal({ cols: 80, rows: 24 });
    window.term.open(document.getElementById("terminal"));
    window.deliveries = [];
    window.term.onData(value => window.deliveries.push(window.terminalData(value)));
  });
  let pending = Promise.resolve();
  output.on("data", value => {
    pending = pending.then(() => page.evaluate(value => new Promise(resolve => window.term.write(value, resolve)), value.toString()));
  });
  const pointers = [];
  const keys = [];
  driver.onPointer(event => pointers.push(event));
  driver.onKey(event => keys.push(event));
  driver.start();
  driver.enterAlternateScreen();
  await pending;
  const bounds = await page.locator(".xterm-screen").boundingBox();
  assert.ok(bounds);
  const point = (column, row) => ({ x: bounds.x + bounds.width * (column + 0.5) / 80, y: bounds.y + bounds.height * (row + 0.5) / 24 });
  const start = point(2, 3);
  const end = point(10, 5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("End");
  await page.evaluate(async () => { await Promise.all(window.deliveries.splice(0)); });
  assert.deepEqual(pointers[0], { type: "down", x: 2, y: 3, button: 0, ctrl: false, alt: false, shift: false });
  assert.ok(pointers.some(event => event.type === "move" && event.button === 0));
  assert.deepEqual(pointers.at(-1), { type: "up", x: 10, y: 5, button: 0, ctrl: false, alt: false, shift: false });
  assert.equal(keys.at(-1).key, "end");
  const count = pointers.length;
  driver.leaveAlternateScreen();
  await pending;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
  await page.evaluate(async () => { await Promise.all(window.deliveries.splice(0)); });
  assert.equal(pointers.length, count);
});
