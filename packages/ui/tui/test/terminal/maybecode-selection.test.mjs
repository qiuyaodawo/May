import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { FullscreenRenderer, NodeTerminalDriver, SystemClipboard, TuiRuntime, TranscriptStore } from "../../dist/index.js";

const require = createRequire(import.meta.url);

test("真实 xterm 中选择 MaybeCode 输入和回复并使用系统剪贴板", {
  timeout: 60_000,
  skip: process.env.MAY_TEST_SYSTEM_CLIPBOARD !== "1",
}, async t => {
  const { MaybeCodePrototypeView } = await import("../../../../../apps/maybecode/dist/ui/prototype-view.js");
  const clipboard = new SystemClipboard();
  const previous = await clipboard.readText();
  if (previous === "") {
    t.skip("当前剪贴板没有可恢复的文字内容");
    return;
  }
  const base = fileURLToPath(new URL("../../../../../review/pointer-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "maybecode-"));
  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(variables)) process.env[key] = directory;
  const browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const input = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  const store = new TranscriptStore();
  store.appendUser("First message\n  indented code");
  store.appendUser("Second message");
  const submitted = [];
  let cancelled = 0;
  let runtime;
  const view = new MaybeCodePrototypeView({
    store,
    workspace: process.cwd(),
    clipboard,
    onSubmit: value => { submitted.push(value); },
    onCancel: () => cancelled++,
    onInvalidate: () => runtime?.requestRender(),
  });
  runtime = new TuiRuntime({ terminal: driver, renderer: new FullscreenRenderer(output), root: view });
  t.after(async () => {
    output.removeAllListeners("data");
    runtime.stop();
    await browser.close();
    await clipboard.writeText(previous);
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
    window.term.focus();
    window.deliveries = [];
    window.term.onData(value => window.deliveries.push(window.terminalData(value)));
  });
  let pending = Promise.resolve();
  output.on("data", value => {
    pending = pending.then(() => page.evaluate(value => new Promise(resolve => window.term.write(value, resolve)), value.toString()));
  });
  const flush = async () => {
    await page.evaluate(async () => { await Promise.all(window.deliveries.splice(0)); });
    await view.waitForPendingClipboard();
    await new Promise(resolve => setImmediate(resolve));
    let previous;
    do { previous = pending; await previous; } while (previous !== pending);
  };
  const press = async key => { await page.keyboard.press(key); await flush(); };
  const paste = async text => { await page.evaluate(text => window.term.paste(text), text); await flush(); };
  const lines = () => page.evaluate(() => Array.from({ length: window.term.rows }, (_, row) => window.term.buffer.active.getLine(row)?.translateToString(true) ?? ""));
  const drag = async (from, to) => {
    const bounds = await page.locator(".xterm-screen").boundingBox();
    assert.ok(bounds);
    const point = ({ x, y }) => ({ x: bounds.x + bounds.width * (x + 0.5) / 80, y: bounds.y + bounds.height * (y + 0.5) / 24 });
    const start = point(from), end = point(to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
    await flush();
  };
  runtime.start();
  await flush();
  const draft = "Alpha 中文 👩‍💻\nBeta";
  await paste(draft);
  await press("Home");
  await press("Shift+End");
  await press("Control+c");
  assert.equal(await clipboard.readText(), "Beta");
  assert.equal(cancelled, 0);
  await press("Control+a");
  await press("Control+x");
  assert.equal(await clipboard.readText(), draft);
  assert.ok((await lines()).some(line => line.includes("Ask MaybeCode")));
  await paste(await clipboard.readText());
  await press("Control+a");
  await paste("edited draft");
  await press("End");
  const cursor = view.render(driver.size).cursor;
  assert.ok(cursor);
  await drag({ x: 3, y: cursor.y }, { x: 9, y: cursor.y });
  await press("Control+c");
  assert.equal(await clipboard.readText(), "edited");
  const frame = await lines();
  const startRow = frame.findIndex(line => line.includes("First message"));
  const endRow = frame.findIndex(line => line.includes("Second message"));
  assert.ok(startRow >= 0 && endRow > startRow);
  await drag({ x: frame[startRow].indexOf("First"), y: startRow }, {
    x: frame[endRow].indexOf("Second message") + "Second message".length,
    y: endRow,
  });
  await press("Control+c");
  assert.equal(await clipboard.readText(), "First message\n  indented code\n\nSecond message");
  assert.equal(cancelled, 0);
  await press("Enter");
  assert.deepEqual(submitted, ["edited draft"]);
});
