import assert from "node:assert/strict";
import test from "node:test";
import { Column, Editor, Panel, Stack, Text } from "../dist/index.js";

const pointer = (type, x, y) => ({ type, x, y, button: 0, ctrl: false, alt: false, shift: false });

test("新的鼠标按下会选择当前组件，之前未收到释放的拖动不占用后续事件", () => {
  const first = new Editor({ value: "first", prompt: "" });
  const second = new Editor({ value: "second", prompt: "" });
  const layout = new Column([{ height: 1, component: first }, { height: 1, component: second }]);
  layout.render({ width: 20, height: 2 });
  layout.handlePointer(pointer("down", 0, 0));
  first.setFocused(false);
  layout.handlePointer(pointer("down", 0, 1));
  layout.handlePointer(pointer("up", 6, 1));
  assert.equal(second.selectedText, "second");
  assert.equal(first.selectedText, "");
  layout.dispose();
});

test("Stack 调整宽度后将拖动事件交给组件的新位置", () => {
  const editor = new Editor({ value: "hello", prompt: "" });
  const layout = new Stack([new Text("abcdefghij"), editor]);
  layout.render({ width: 20, height: 8 });
  layout.handlePointer(pointer("down", 0, 1));
  layout.render({ width: 5, height: 8 });
  layout.handlePointer(pointer("up", 3, 2));
  assert.equal(editor.selectedText, "hel");
  layout.dispose();
});

test("Panel 和 Column 保留可复制文字的屏幕位置", () => {
  const layout = new Column([{ height: 4, component: new Panel(new Text("中文", { sourceId: "text" })) }]);
  const result = layout.render({ width: 12, height: 4 });
  assert.equal(result.textRows[1].source, "中文");
  assert.equal(result.textRows[1].spans[0].x, 1);
});
