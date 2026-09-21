import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NodeTerminalDriver, ScrollView, Text } from "../dist/index.js";
import { keyStroke } from "@may/keybindings";

test("decodes fragmented and consecutive mouse reports without inserting them as text", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  t.after(() => driver.close());
  const strokes = [];
  driver.onKey((stroke) => strokes.push(stroke));
  driver.start();
  driver.enterAlternateScreen();

  const report = "\x1b[<64;120;40M";
  for (let boundary = 1; boundary < report.length; boundary++) {
    input.write(report.slice(0, boundary));
    input.write(report.slice(boundary));
  }
  assert.deepEqual(strokes.map((stroke) => stroke.key), Array(report.length - 1).fill("wheelup"));
  strokes.length = 0;
  input.write("a\x1b[<65;120;40M\x1b[<0;2;3M\x1b[<0;2;3m\x1b[<35;2;3M\x1b[<66;2;3Mz");
  input.write(Buffer.from([0x1b, 0x5b, 0x4d, 96, 40, 40]));
  input.write("\x1b[<92;2;3M\x1b[A\x1b[B");
  assert.deepEqual(strokes.map((stroke) => stroke.key), [
    "a", "wheeldown", "z", "wheelup", "wheelup", "up", "down",
  ]);
  assert.deepEqual(strokes[4], keyStroke("wheelup", { ctrl: true, alt: true, shift: true }));
  assert.equal(strokes[1].text, undefined);

  strokes.length = 0;
  const pasted = `中文\n${report}`;
  input.write(`\x1b[200~${pasted}\x1b[201~`);
  const unicode = Buffer.from("中文");
  for (const byte of unicode) input.write(Buffer.from([byte]));
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(strokes.map(({ key, text }) => ({ key, text })), [
    { key: "paste", text: pasted },
    { key: "中", text: "中" },
    { key: "文", text: "文" },
    { key: "escape", text: undefined },
  ]);
});

test("restores mouse modes and handles restarting after an incomplete report", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => written += chunk.toString());
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  const strokes = [];
  driver.onKey((stroke) => strokes.push(stroke.key));
  for (let cycle = 0; cycle < 2; cycle++) {
    driver.start();
    driver.enterAlternateScreen();
    driver.enterAlternateScreen();
    input.write("\x1b[<64;1;1M");
    input.write("\x1b[<64;");
    driver.close();
    driver.close();
    assert.equal(input.listenerCount("data"), 0);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(strokes, ["wheelup", "wheelup"]);
  assert.equal(written.split("\x1b[?1000h").length - 1, 2);
  assert.equal(written.split("\x1b[?1006h").length - 1, 2);
  assert.equal(written.split("\x1b[?1000l\x1b[?1006l").length - 1, 2);
});

test("scrolls three rows per wheel event within the content boundaries", () => {
  const content = new Text("1\n2\n3\n4\n5\n6\n7\n8");
  const scroll = new ScrollView(content, { followEnd: true });
  scroll.setFocused(true);
  const size = { width: 20, height: 2 };
  assert.deepEqual(scroll.render(size).lines, ["7", "8"]);
  scroll.handleKey(keyStroke("wheelup"));
  assert.deepEqual(scroll.render(size).lines, ["4", "5"]);
  scroll.handleKey(keyStroke("wheelup"));
  assert.deepEqual(scroll.render(size).lines, ["1", "2"]);
  assert.equal(scroll.handleKey(keyStroke("wheelup")), true);
  assert.deepEqual(scroll.handleKeyResult(keyStroke("wheelup")), { consumed: true, redraw: false });
  scroll.handleKey(keyStroke("wheeldown"));
  scroll.handleKey(keyStroke("wheeldown"));
  assert.deepEqual(scroll.render(size).lines, ["7", "8"]);
});
