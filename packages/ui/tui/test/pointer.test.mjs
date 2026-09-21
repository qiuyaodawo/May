import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NodeTerminalDriver } from "../dist/index.js";

test("按下、拖动、释放报告转换为从零开始的坐标和按键编号", t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  t.after(() => driver.close());
  const pointers = [];
  const keys = [];
  const remove = driver.onPointer(event => pointers.push(event));
  driver.onKey(event => keys.push(event));
  driver.start();
  input.write("\x1b[<0;1;1M");
  assert.deepEqual(pointers, []);
  driver.enterAlternateScreen();
  for (const byte of Buffer.from("\x1b[<0;2;3M\x1b[<32;8;3M\x1b[<0;8;3m")) input.write(Buffer.from([byte]));
  assert.deepEqual(pointers, [
    { type: "down", x: 1, y: 2, button: 0, ctrl: false, alt: false, shift: false },
    { type: "move", x: 7, y: 2, button: 0, ctrl: false, alt: false, shift: false },
    { type: "up", x: 7, y: 2, button: 0, ctrl: false, alt: false, shift: false },
  ]);
  input.write("\x1b[<30;4;5M\x1b[<35;4;5M");
  assert.deepEqual(pointers.at(-2), { type: "down", x: 3, y: 4, button: 2, ctrl: true, alt: true, shift: true });
  assert.equal(pointers.at(-1).button, -1);
  assert.equal(keys.length, 0);
  driver.leaveAlternateScreen();
  input.write("\x1b[<0;1;1M");
  assert.equal(pointers.length, 5);
  remove();
  driver.enterAlternateScreen();
  input.write("\x1b[<0;1;1M");
  assert.equal(pointers.length, 5);
});

test("终端生命周期启用拖动报告并完整关闭鼠标模式", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let content = "";
  output.on("data", chunk => content += chunk.toString());
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  driver.start();
  driver.enterAlternateScreen();
  driver.enterAlternateScreen();
  driver.close();
  assert.equal(content.split("\x1b[?1002h").length - 1, 1);
  assert.equal(content.split("\x1b[?1002l").length - 1, 1);
  assert.ok(content.indexOf("\x1b[?1002l") < content.indexOf("\x1b[?1049l"));
  assert.equal(input.listenerCount("data"), 0);
});
