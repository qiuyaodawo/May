import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { Text, TranscriptStore, TranscriptView, DEFAULT_DARK_THEME } from "../dist/index.js";

test("通知续行保留缩进，复制包含完整路径、中文和 emoji", () => {
  const notice = "Task " + "abcdefghij".repeat(8) + "\n      files 中文目录/👩‍💻/" + "long-directory/".repeat(8);
  const store = new TranscriptStore();
  store.appendNotice("info", notice);
  const theme = { ...DEFAULT_DARK_THEME, muted: { foreground: "#94a3b8", bold: true } };
  const view = new TranscriptView(store, { theme });
  for (const width of [8, 24, 80, 120]) {
    const rendered = view.render({ width, height: 2000 });
    for (const [index, line] of rendered.lines.entries()) {
      assert.ok(stringWidth(line) <= width);
      if (index > 0 && stripVTControlCharacters(line).trim() !== "") assert.match(stripVTControlCharacters(line), /^ {2}/u);
      if (stripVTControlCharacters(line).trim() !== "") assert.ok(line.includes("38;2;148;163;184"));
    }
    const pointer = (type, x, y) => ({ type, x, y, button: 0, ctrl: false, alt: false, shift: false });
    view.handlePointer(pointer("down", 2, 0));
    view.handlePointer(pointer("up", width, rendered.lines.length - 1));
    assert.equal(view.selectedText, notice);
    view.clearSelection();
  }
});

test("Text 续行缩进校验以及窄窗口和关闭换行", () => {
  for (const value of [-1, 1.5, Infinity, NaN]) {
    assert.throws(() => new Text("text", { continuationIndent: value }).render({ width: 20, height: 20 }), RangeError);
  }
  for (const width of [1, 2, 3, 20]) {
    const result = new Text("abcdefghij", { continuationIndent: 100 }).render({ width, height: 20 });
    assert.ok(result.lines.every(line => stringWidth(line) <= width));
  }
  assert.deepEqual(new Text("abcdefgh", { continuationIndent: 4, wrap: false }).render({ width: 5, height: 2 }).lines, ["abcde"]);
});
