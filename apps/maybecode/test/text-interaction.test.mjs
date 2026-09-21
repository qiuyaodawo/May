import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { keyStroke } from "@may/keybindings";
import { createTerminalClipboard } from "@may/tui";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";
import { createMaybeCodeKeymap } from "../dist/keymap.js";

const key = (view, name, modifiers = {}) => view.handleKey(keyStroke(name, modifiers));
const input = (view, text) => key(view, "paste", { text });
const render = view => view.render({ width: 100, height: 24 }).lines.map(stripVTControlCharacters).join("\n");

test("MaybeCode 使用有效组合键生成提示并保留文字编辑按键", t => {
  const keymap = createMaybeCodeKeymap({ leader: "ctrl+q" });
  assert.deepEqual(keymap.keysForAction("app.reply.start"), ["ctrl+q r"]);
  assert.throws(() => createMaybeCodeKeymap({ leader: "ctrl+x" }), /conflicts/);
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

test("命令建议显示时 Shift+Enter 插入换行", async t => {
  const submitted = [];
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: "workspace",
    suggestions: async () => [{ value: "/resume", label: "/resume", description: "Resume" }],
    onSubmit: value => submitted.push(value) });
  t.after(() => view.dispose());
  input(view, "/res");
  await new Promise(resolve => setImmediate(resolve));
  key(view, "enter", { shift: true });
  assert.deepEqual(submitted, []);
  assert.match(render(view), /\/res/);
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
