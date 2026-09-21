import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { keyStroke } from "@may/keybindings";
import { Editor, EditorHistory } from "../dist/editor.js";
import { createTerminalClipboard } from "../dist/clipboard.js";
import { EDITOR_ACTIONS } from "../dist/editor-keymap.js";

function editor(value, options = {}) {
  const result = new Editor({ value, ...options });
  result.setFocused(true);
  return result;
}

function pointer(type, x, y, modifiers = {}) {
  return { type, x, y, button: 0, ctrl: false, alt: false, shift: false, ...modifiers };
}

test("输入框选择和替换完整中文、emoji 与组合字符", () => {
  const input = editor("前👨‍👩‍👧‍👦e\u0301后");
  assert.equal(input.cursor, 4);
  input.handleKey(keyStroke("left", { shift: true }));
  input.handleKey(keyStroke("left", { shift: true }));
  assert.equal(input.selectedText, "e\u0301后");
  input.handleKey(keyStroke("left", { shift: true }));
  assert.equal(input.selectedText, "👨‍👩‍👧‍👦e\u0301后");
  input.handleKey(keyStroke("paste", { text: "新的\r\n内容" }));
  assert.equal(input.value, "前新的\n内容");
  assert.equal(input.hasSelection, false);
  input.handleKey(keyStroke("a", { ctrl: true }));
  assert.equal(input.selectedText, input.value);
  input.handleKey(keyStroke("x", { text: "替换" }));
  assert.equal(input.value, "替换");
});

test("Home 和 End 按照内容换行移动并处理没有位置变化的按键", () => {
  const input = editor("abcdefgh\n第二行");
  input.setValue(input.value, 2);
  input.render({ width: 6, height: 4 });
  assert.deepEqual(input.handleKeyResult(keyStroke("end")), { consumed: true, redraw: true });
  assert.equal(input.cursor, 8);
  assert.deepEqual(input.handleKeyResult(keyStroke("end")), { consumed: true, redraw: false });
  input.handleKey(keyStroke("home", { shift: true }));
  assert.equal(input.selectedText, "abcdefgh");
  input.handleKey(keyStroke("right"));
  assert.equal(input.cursor, 8);
  assert.equal(input.hasSelection, false);
  input.handleKey(keyStroke("home"));
  assert.equal(input.cursor, 0);
  assert.deepEqual(input.handleKeyResult(keyStroke("home")), { consumed: true, redraw: false });
  assert.deepEqual(input.handleKeyResult(keyStroke("backspace")), { consumed: true, redraw: false });
});

test("单词选择、方向移动和删除使用相同的选择范围", () => {
  const input = editor("alpha 中文 beta");
  input.handleKey(keyStroke("left", { ctrl: true, shift: true }));
  assert.equal(input.selectedText, "beta");
  input.handleKey(keyStroke("left", { alt: true, shift: true }));
  assert.equal(input.selectedText, "中文 beta");
  input.handleKey(keyStroke("left"));
  assert.equal(input.cursor, 6);
  assert.equal(input.hasSelection, false);
  input.handleKey(keyStroke("end", { shift: true }));
  input.handleKey(keyStroke("delete"));
  assert.equal(input.value, "alpha ");
  input.handleKey(keyStroke("a", { ctrl: true }));
  input.handleKey(keyStroke("w", { ctrl: true }));
  assert.equal(input.value, "");
});

test("单击定位或者边界选择之后删除文字不会留下选择范围", () => {
  const input = editor("abc");
  input.render({ width: 10, height: 2 });
  input.handlePointer(pointer("down", 5, 0));
  input.handlePointer(pointer("up", 5, 0));
  input.handleKey(keyStroke("backspace"));
  assert.equal(input.value, "ab");
  assert.equal(input.hasSelection, false);
  input.handleKey(keyStroke("right", { shift: true }));
  input.handleKey(keyStroke("w", { ctrl: true }));
  assert.equal(input.value, "");
  assert.equal(input.hasSelection, false);
  input.setValue("abc", 1);
  input.render({ width: 10, height: 2 });
  input.handlePointer(pointer("down", 3, 0));
  input.handlePointer(pointer("up", 3, 0));
  input.handleKey(keyStroke("delete"));
  assert.equal(input.value, "ac");
  assert.equal(input.hasSelection, false);
});

test("上下方向按照屏幕列移动并保留经过短行之前的列位置", () => {
  const input = editor("abcd\nx\n中文yz");
  input.render({ width: 20, height: 5 });
  input.handleKey(keyStroke("up", { shift: true }));
  assert.equal(input.cursor, 6);
  input.handleKey(keyStroke("up", { shift: true }));
  assert.equal(input.cursor, 4);
  assert.equal(input.selectedText, "\nx\n中文yz");
  input.handleKey(keyStroke("down"));
  assert.equal(input.cursor, 6);
  input.handleKey(keyStroke("down"));
  assert.equal(input.cursor, 11);
  assert.equal(input.hasSelection, false);
});

test("自动换行后使用上下方向选择文字", () => {
  const input = editor("abcdefghij");
  input.render({ width: 6, height: 4 });
  input.handleKey(keyStroke("up", { shift: true }));
  assert.equal(input.cursor, 6);
  assert.equal(input.selectedText, "ghij");
  input.handleKey(keyStroke("up", { shift: true }));
  assert.equal(input.cursor, 2);
  assert.equal(input.selectedText, "cdefghij");
});

test("鼠标使用屏幕坐标选择完整字符并允许 Shift 延伸选择", () => {
  const input = editor("甲🙂乙ab");
  input.render({ width: 8, height: 4 });
  input.handlePointer(pointer("down", 4, 0));
  input.handlePointer(pointer("move", 3, 1));
  input.handlePointer(pointer("up", 3, 1));
  assert.equal(input.selectedText, "🙂乙a");
  assert.equal(input.cursor, 4);
  input.handlePointer(pointer("down", 4, 1, { shift: true }));
  input.handlePointer(pointer("up", 4, 1));
  assert.equal(input.selectedText, "🙂乙ab");
  const selected = input.selectedText;
  const result = input.render({ width: 20, height: 2 });
  assert.equal(input.selectedText, selected);
  assert.equal(stripVTControlCharacters(result.lines[0]), "> 甲🙂乙ab");
  assert.match(result.lines[0], /\x1b\[7m/u);
  input.clearSelection();
  assert.equal(input.hasSelection, false);
});

test("鼠标定位使用输入框当前可见区域", () => {
  const input = editor("one\ntwo\nthree\nfour");
  input.render({ width: 12, height: 2 });
  input.handlePointer(pointer("down", 2, 0));
  input.handlePointer(pointer("up", 7, 0));
  assert.equal(input.selectedText, "three");
});

test("拖动到输入框边缘时持续滚动并在释放或销毁后停止", async () => {
  const input = editor("a\nb\nc\nd\ne\nf\ng\nh");
  input.render({ width: 6, height: 2 });
  input.handlePointer(pointer("down", 3, 1));
  input.handlePointer(pointer("move", 2, -1));
  const first = input.selectedText;
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.ok(input.selectedText.length > first.length);
  input.handlePointer(pointer("up", 2, -1));
  const selected = input.selectedText;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(input.selectedText, selected);
  input.handlePointer(pointer("down", 2, 0));
  input.handlePointer(pointer("move", 3, 2));
  input.dispose();
  const disposed = input.selectedText;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(input.selectedText, disposed);
  assert.equal(input.handleKey(keyStroke("a", { ctrl: true })), false);
});

test("Shift 上下选择不会切换输入历史", () => {
  const history = new EditorHistory({ entries: ["previous"] });
  const input = editor("draft", { history });
  input.render({ width: 20, height: 2 });
  input.handleKey(keyStroke("up", { shift: true }));
  assert.equal(input.value, "draft");
  input.handleKey(keyStroke("up"));
  assert.equal(input.value, "previous");
  input.handleKey(keyStroke("down"));
  assert.equal(input.value, "draft");
});

test("快捷键覆盖可以替换默认动作和已有按键", () => {
  const input = editor("text", { keybindings: [
    { context: "editor", keys: "ctrl+q", action: EDITOR_ACTIONS.selectAll },
    { context: "editor", keys: "home", action: EDITOR_ACTIONS.lineEnd },
  ] });
  assert.equal(input.handleKey(keyStroke("a", { ctrl: true })), false);
  input.handleKey(keyStroke("q", { ctrl: true }));
  assert.equal(input.selectedText, "text");
  input.handleKey(keyStroke("left"));
  assert.equal(input.cursor, 0);
  input.handleKey(keyStroke("home"));
  assert.equal(input.cursor, 4);
  assert.throws(() => editor("", { keybindings: [
    { context: "other", keys: "ctrl+q", action: EDITOR_ACTIONS.selectAll },
  ] }), /Unknown editor keybinding context/u);
});

test("焦点变化和选择上下文变化清除未完成的连续组合键", () => {
  const input = editor("text", { keybindings: [
    { context: "editor", keys: "ctrl+q a", action: EDITOR_ACTIONS.selectAll },
  ] });
  input.handleKey(keyStroke("q", { ctrl: true }));
  input.setFocused(false);
  input.setFocused(true);
  input.handleKey(keyStroke("a", { text: "a" }));
  assert.equal(input.value, "texta");
  assert.equal(input.hasSelection, false);
  input.handleKey(keyStroke("q", { ctrl: true }));
  input.selectAll();
  input.handleKey(keyStroke("a", { text: "a" }));
  assert.equal(input.value, "a");
});

test("没有选择时复制按键交给外层，剪贴板拒绝剪切时保留文字", async () => {
  const errors = [];
  const input = editor("保留内容", {
    clipboard: createTerminalClipboard({ mode: "disabled" }),
    onError: (error) => errors.push(error),
  });
  assert.equal(input.handleKey(keyStroke("c", { ctrl: true })), false);
  input.selectAll();
  assert.equal(input.handleKey(keyStroke("x", { ctrl: true })), true);
  await assert.rejects(input.waitForPendingClipboard(), /Clipboard access is disabled/u);
  assert.equal(input.value, "保留内容");
  assert.equal(input.selectedText, "保留内容");
  assert.equal(errors.length, 1);
  input.handleKey(keyStroke("v", { ctrl: true }));
  await assert.rejects(input.waitForPendingClipboard(), /Clipboard access is disabled/u);
  assert.equal(input.value, "保留内容");
  assert.equal(errors.length, 2);
});
