import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { keyStroke } from "@may/keybindings";
import { Editor, FullscreenRenderer, NodeTerminalDriver, TuiRuntime } from "../dist/index.js";

test("Runtime 释放旧组件并在停止后拒绝再次启动", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", value => written += value.toString());
  const terminal = new NodeTerminalDriver({ input, output, requireTTY: false });
  const editor = new Editor();
  editor.setFocused(true);
  const runtime = new TuiRuntime({ terminal, renderer: new FullscreenRenderer(output), root: editor });
  runtime.start();
  input.write("a");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.value, "a");
  const before = written;
  runtime.setRoot(editor);
  input.write("\x1b[F");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(written, before);
  const replacement = new Editor();
  replacement.setFocused(true);
  runtime.setRoot(replacement);
  input.write("b");
  assert.equal(replacement.value, "b");
  assert.equal(editor.handleKey(keyStroke("x", { text: "x" })), false);
  runtime.stop();
  runtime.stop();
  assert.equal(runtime.isRunning, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(replacement.handleKey(keyStroke("x", { text: "x" })), false);
  assert.throws(() => runtime.start(), /new runtime/u);
  assert.throws(() => runtime.setRoot(new Editor()), /new runtime/u);
});

test("启动失败会释放组件且不会写入终端控制序列", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", value => written += value.toString());
  const terminal = new NodeTerminalDriver({ input, output });
  const editor = new Editor();
  editor.setFocused(true);
  const runtime = new TuiRuntime({ terminal, renderer: new FullscreenRenderer(output), root: editor });
  assert.throws(() => runtime.start(), /interactive terminal/u);
  assert.equal(editor.handleKey(keyStroke("x", { text: "x" })), false);
  assert.equal(written, "");
  assert.throws(() => runtime.start(), /new runtime/u);
});

test("启动前停止同样释放组件", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new NodeTerminalDriver({ input, output, requireTTY: false });
  const editor = new Editor();
  editor.setFocused(true);
  const runtime = new TuiRuntime({ terminal, renderer: new FullscreenRenderer(output), root: editor });
  runtime.stop();
  assert.equal(editor.handleKey(keyStroke("x", { text: "x" })), false);
  assert.throws(() => runtime.start(), /new runtime/u);
});
