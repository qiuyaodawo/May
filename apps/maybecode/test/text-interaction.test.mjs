import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { keyStroke } from "@sortedyuan/tui/keybindings";
import { createTerminalClipboard, NodeTerminalDriver } from "@sortedyuan/tui";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";
import { createMaybeCodeKeymap } from "../dist/keymap.js";
import { matchMaybeCodeSlashCommands } from "../dist/slash-commands.js";

const key = (view, name, modifiers = {}) => view.handleKey(keyStroke(name, modifiers));
const input = (view, text) => key(view, "paste", { text });
const render = view => view.render({ width: 100, height: 24 }).lines.map(stripVTControlCharacters).join("\n");

test("MaybeCode 使用有效组合键生成提示并保留文字编辑按键", t => {
  const keymap = createMaybeCodeKeymap({ leader: "ctrl+q" });
  assert.deepEqual(keymap.keysForAction("app.reply.start"), ["ctrl+q r"]);
  assert.throws(() => createMaybeCodeKeymap({ leader: "ctrl+x" }), /conflicts/);
  assert.throws(() => createMaybeCodeKeymap({ leader: "ctrl+j" }), /conflicts/);
  assert.throws(() => createMaybeCodeKeymap({ leader: "x" }), /modified/);
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    keymap: { leader: "ctrl+q" }, onSubmit: () => assert.fail("快捷键不能提交文字") });
  t.after(() => view.dispose());
  assert.match(render(view), /Ctrl\+Q R/);
  input(view, "draft");
  key(view, "a", { ctrl: true });
  key(view, "q", { ctrl: true });
  key(view, "d", { text: "d" });
  assert.match(render(view), /Tool details shown/);
  assert.match(render(view), /draft/);
});

test("输入框复制清除待完成组合键，失败时保留选择且不取消任务", async t => {
  const submitted = [];
  let cancelled = 0;
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    clipboard: createTerminalClipboard({ mode: "disabled" }),
    onSubmit: value => submitted.push(value), onCancel: () => cancelled++ });
  t.after(() => view.dispose());
  input(view, "draft");
  key(view, "a", { ctrl: true });
  key(view, "g", { ctrl: true });
  key(view, "c", { ctrl: true });
  await assert.rejects(view.waitForPendingClipboard(), /Clipboard access is disabled/);
  assert.match(render(view), /Clipboard access is disabled/);
  assert.equal(cancelled, 0);
  key(view, "r", { text: "r" });
  key(view, "enter");
  assert.deepEqual(submitted, ["r"]);
});

test("输入框 End 和 Shift+End 按逻辑行操作，多行替换保留行尾", t => {
  const submitted = [];
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    onSubmit: value => submitted.push(value) });
  t.after(() => view.dispose());
  input(view, "first\n中文👩‍💻 last");
  key(view, "home");
  key(view, "right");
  key(view, "end", { shift: true });
  input(view, "replacement");
  key(view, "end");
  key(view, "end");
  key(view, "enter");
  assert.deepEqual(submitted, ["first\n中replacement"]);
});

test("命令建议显示时 Ctrl+J 插入换行并通过 Enter 提交", async t => {
  const submitted = [];
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    suggestions: matchMaybeCodeSlashCommands,
    onSubmit: value => submitted.push(value) });
  t.after(() => view.dispose());
  input(view, "/res");
  await new Promise(resolve => setImmediate(resolve));
  key(view, "j", { ctrl: true });
  assert.deepEqual(submitted, []);
  input(view, "next");
  await new Promise(resolve => setImmediate(resolve));
  key(view, "enter");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ["/res\nnext"]);
});

test("终端 LF 插入换行，CR 提交，bracketed paste 保留换行", async t => {
  const submitted = [];
  const source = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input: source, output, requireTTY: false });
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    onSubmit: value => submitted.push(value) });
  t.after(() => { driver.close(); view.dispose(); });
  const strokes = [];
  driver.onKey(stroke => { strokes.push(stroke); view.handleKey(stroke); });
  driver.start();
  source.write("first\nsecond");
  assert.deepEqual(submitted, []);
  assert.deepEqual(strokes.find(stroke => stroke.ctrl), keyStroke("j", { ctrl: true }));
  source.write("\r");
  assert.deepEqual(submitted, ["first\nsecond"]);
  await new Promise(resolve => setImmediate(resolve));
  source.write("\x1b[200~third\nfourth\x1b[201~");
  assert.deepEqual(submitted, ["first\nsecond"]);
  source.write("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ["first\nsecond", "third\nfourth"]);
});

test("弹窗结束后恢复输入框，并清除进入弹窗之前的组合键", async t => {
  const submitted = [];
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    onSubmit: value => submitted.push(value) });
  t.after(() => view.dispose());
  input(view, "draft");
  key(view, "g", { ctrl: true });
  const dialog = view.requestSessionAction([], "session");
  render(view);
  key(view, "escape");
  assert.equal(await dialog, undefined);
  key(view, "r", { text: "r" });
  key(view, "enter");
  assert.deepEqual(submitted, ["draftr"]);
});
