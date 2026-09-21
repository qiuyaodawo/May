import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { keyStroke } from "@may/keybindings";
import { Markdown, ScrollView, Text } from "../dist/index.js";
import { TranscriptStore, TranscriptView } from "../dist/agent/transcript.js";
import { ToolRendererRegistry } from "../dist/agent/tool-renderers.js";
import { TerminalImages } from "../dist/images.js";

const pointer = (type, x, y) => ({ type, x, y, button: 0, ctrl: false, alt: false, shift: false });
const plainLines = result => result.lines.map(stripVTControlCharacters);

test("重复绘制保留空行之后的阅读位置，也保留位于顶部的空行", () => {
  const scroll = new ScrollView(new Text("heading\n\n\nfirst\nsecond\nthird", { sourceId: "document" }));
  const size = { width: 20, height: 2 };
  scroll.render(size);
  scroll.scrollBy(3);
  assert.deepEqual(scroll.render(size).lines, ["first", "second"]);
  assert.deepEqual(scroll.render(size).lines, ["first", "second"]);
  scroll.scrollBy(-1);
  assert.deepEqual(scroll.render(size).lines, ["", "first"]);
  assert.deepEqual(scroll.render(size).lines, ["", "first"]);
  scroll.dispose();
});

function appendAssistant(store, text, runId = "run-1") {
  store.applyMayEvent({ type: "model.completed", runId, step: 1, seq: 1, timestamp: 1,
    contextMessageCount: 1, message: { role: "assistant", content: [{ type: "text", text }] } });
}

test("copies user text across automatic wrapping without labels or additional newlines", () => {
  const store = new TranscriptStore();
  store.appendUser("你好😊 alpha beta\n  next");
  const view = new TranscriptView(store);
  const result = view.render({ width: 10, height: 20 });
  assert.deepEqual(plainLines(result), ["› You", "  你好😊 ", "alpha beta", "    next"]);
  view.handlePointer(pointer("down", 2, 1));
  view.handlePointer(pointer("up", 8, 3));
  assert.equal(view.selectedText, "你好😊 alpha beta\n  next");
  assert.equal(view.hasSelection, true);
  assert.match(view.render({ width: 10, height: 20 }).lines[1], /\x1b\[7m/u);
  view.clearSelection();
  assert.equal(view.hasSelection, false);
});

test("copies code indentation and real newlines without Markdown borders", () => {
  const store = new TranscriptStore();
  appendAssistant(store, "```js\n  const 你好 = 1;\n    next();\n```");
  const view = new TranscriptView(store);
  const result = view.render({ width: 12, height: 30 });
  const lines = plainLines(result);
  assert.equal(lines[1], "┌─ code [js]");
  view.handlePointer(pointer("down", 2, 2));
  view.handlePointer(pointer("up", 12, lines.length - 1));
  assert.equal(view.selectedText, "  const 你好 = 1;\n    next();");
  assert.doesNotMatch(view.selectedText, /[│┌\x1b]/u);
});

test("selection spans user and assistant messages and supports reverse dragging", () => {
  const store = new TranscriptStore();
  store.appendUser("question");
  appendAssistant(store, "answer");
  const view = new TranscriptView(store);
  const result = view.render({ width: 30, height: 20 });
  const lines = plainLines(result);
  view.handlePointer(pointer("down", 6, lines.indexOf("answer")));
  view.handlePointer(pointer("up", 2, lines.indexOf("  question")));
  assert.equal(view.selectedText, "question\n\nanswer");
});

test("selection stays attached to graphemes while streaming and resizing", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, type: "model.text.delta", seq: 1, delta: "A你好👩‍💻BC" });
  const view = new TranscriptView(store);
  view.render({ width: 30, height: 20 });
  view.handlePointer(pointer("down", 1, 1));
  view.handlePointer(pointer("up", 7, 1));
  assert.equal(view.selectedText, "你好👩‍💻");
  store.applyMayEvent({ ...base, type: "model.text.delta", seq: 2, delta: " appended text" });
  const result = view.render({ width: 5, height: 30 });
  assert.equal(view.selectedText, "你好👩‍💻");
  assert.equal(result.lines.filter(line => line.includes("\x1b[7m")).length, 2);
  store.reset("another-session");
  view.render({ width: 5, height: 30 });
  assert.equal(view.selectedText, "");
});

test("tool output selection excludes renderer borders and preserves indentation", () => {
  const store = new TranscriptStore();
  store.applyMayEvent({ type: "tool.completed", runId: "run-1", step: 1, timestamp: 1, seq: 1,
    call: { id: "shell-1", name: "shell", input: { command: "printf output" } },
    output: { stdout: "  one\n    two", stderr: "", exitCode: 0 } });
  const view = new TranscriptView(store);
  const result = view.render({ width: 40, height: 20 });
  const lines = plainLines(result);
  view.handlePointer(pointer("down", 4, lines.indexOf("  │   one")));
  view.handlePointer(pointer("up", 11, lines.indexOf("  │     two")));
  assert.equal(view.selectedText, "  one\n    two");
});

test("流式 Markdown 标记完成后保留所选正文，继续追加文字不扩大选择", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, type: "model.text.delta", seq: 1, delta: "*hello" });
  const view = new TranscriptView(store);
  view.render({ width: 30, height: 20 });
  view.handlePointer(pointer("down", 1, 1));
  view.handlePointer(pointer("up", 6, 1));
  assert.equal(view.selectedText, "hello");
  store.applyMayEvent({ ...base, type: "model.text.delta", seq: 2, delta: "* world" });
  view.render({ width: 30, height: 20 });
  assert.equal(view.selectedText, "hello");
  store.applyMayEvent({ ...base, type: "model.text.delta", seq: 3, delta: " more" });
  view.render({ width: 5, height: 30 });
  assert.equal(view.selectedText, "hello");
});

test("自定义工具文字保留字面符号，可通过渲染元数据排除装饰", () => {
  const store = new TranscriptStore();
  store.applyMayEvent({ type: "tool.completed", runId: "run-1", step: 1, timestamp: 1, seq: 1,
    call: { id: "tool-1", name: "custom", input: {} }, output: "  │ literal border" });
  const toolRenderers = new ToolRendererRegistry().register("custom", {
    render: item => String(item.output),
  });
  const view = new TranscriptView(store, { toolRenderers });
  view.render({ width: 30, height: 10 });
  view.handlePointer(pointer("down", 0, 0));
  view.handlePointer(pointer("up", 30, 0));
  assert.equal(view.selectedText, "  │ literal border");
  const documentRenderers = new ToolRendererRegistry().register("custom", {
    render: item => String(item.output),
    renderDocument: item => [{ value: String(item.output), copy: { start: 4, end: String(item.output).length } }],
  });
  const documentView = new TranscriptView(store, { toolRenderers: documentRenderers });
  documentView.render({ width: 30, height: 10 });
  documentView.handlePointer(pointer("down", 0, 0));
  documentView.handlePointer(pointer("up", 30, 0));
  assert.equal(documentView.selectedText, "literal border");
});

test("文件读取工具的行号和边框不进入复制内容", () => {
  const store = new TranscriptStore();
  store.applyMayEvent({ type: "tool.completed", runId: "run-1", step: 1, timestamp: 1, seq: 1,
    call: { id: "read-1", name: "read", input: { path: "a.ts" } },
    output: { path: "a.ts", startLine: 9, endLine: 10, totalLines: 10, content: "  first\n    second" } });
  const view = new TranscriptView(store, { showToolDetails: true });
  const result = view.render({ width: 40, height: 20 });
  const lines = plainLines(result);
  view.handlePointer(pointer("down", 9, lines.indexOf("  │  9 │   first")));
  view.handlePointer(pointer("up", 40, lines.indexOf("  │ 10 │     second")));
  assert.equal(view.selectedText, "  first\n    second");
});

test("图片链接按原有顺序加入文字选择并保留自动换行前的地址", () => {
  const store = new TranscriptStore();
  store.applyMayEvent({ type: "model.completed", runId: "run-1", step: 1, seq: 1, timestamp: 1,
    contextMessageCount: 1, message: { role: "assistant", content: [
      { type: "text", text: "before" },
      { type: "image", source: { type: "url", url: "https://example.com/long-image.png" } },
      { type: "text", text: "after" },
    ] } });
  const view = new TranscriptView(store, { images: new TerminalImages(undefined, "none") });
  const result = view.render({ width: 14, height: 20 });
  const lines = plainLines(result);
  view.handlePointer(pointer("down", 0, lines.indexOf("before")));
  view.handlePointer(pointer("up", 5, lines.indexOf("after")));
  assert.equal(view.selectedText, "before\n\n图片链接：https://example.com/long-image.png\n\nafter");
});

test("a held pointer extends selection while scrolling and stops on release", async () => {
  const store = new TranscriptStore();
  store.appendUser(Array.from({ length: 15 }, (_, index) => `line${index}`).join("\n"));
  const view = new TranscriptView(store);
  const size = { width: 30, height: 5 };
  const scroll = new ScrollView(view, { onInvalidate: () => { scroll.render(size); } });
  scroll.render(size);
  scroll.handlePointer(pointer("down", 2, 1));
  scroll.handlePointer(pointer("move", 20, 4));
  await delay(155);
  assert.ok(scroll.scrollOffset >= 2);
  assert.match(view.selectedText, /^line0\nline1\nline2\nline3\nline4\nline5/u);
  scroll.handlePointer(pointer("up", 20, 4));
  const offset = scroll.scrollOffset;
  await delay(90);
  assert.equal(scroll.scrollOffset, offset);
  scroll.dispose();
});

test("scroll selection suspends following, retains source anchors across tail trimming and resize", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, seq: 1, type: "model.text.delta", delta: "zero\none\ntwo\nthree\nfour\nfive\nsix" });
  const view = new TranscriptView(store);
  const scroll = new ScrollView(view, { followEnd: true, maxContentLines: 6 });
  const size = { width: 20, height: 3 };
  assert.deepEqual(plainLines(scroll.render(size)), ["four", "five", "six"]);
  scroll.handlePointer(pointer("down", 0, 0));
  scroll.handlePointer(pointer("up", 4, 1));
  store.applyMayEvent({ ...base, seq: 2, type: "model.text.delta", delta: "\nseven\neight" });
  assert.deepEqual(plainLines(scroll.render(size)), ["four", "five", "six"]);
  assert.equal(view.selectedText, "four\nfive");
  scroll.render({ width: 4, height: 3 });
  assert.equal(view.selectedText, "four\nfive");
  scroll.dispose();
});

test("scroll boundary keys remain consumed and ignore unrelated modifiers", () => {
  const scroll = new ScrollView(new Text("only row"));
  scroll.setFocused(true);
  scroll.render({ width: 30, height: 4 });
  assert.equal(scroll.handleKey(keyStroke("end")), true);
  assert.equal(scroll.handleKey(keyStroke("end")), true);
  assert.equal(scroll.handleKey(keyStroke("home")), true);
  assert.equal(scroll.handleKey(keyStroke("end", { ctrl: true })), false);
});

test("Markdown layout metadata excludes quote and code decorations before wrapping", () => {
  const result = new Markdown("> ```js\n>   let x = 1;\n> ```", { colors: false, sourceId: "body" })
    .render({ width: 9, height: 20 });
  assert.equal(result.textRows.find(row => row !== undefined).source, "  let x = 1;");
  const spans = result.textRows.flatMap(row => row?.spans ?? []);
  assert.equal(spans[0].start, 0);
  assert.equal(spans.at(-1).end, 12);
});

test("代码中的空行和 Tab 在选择复制后保留，Tab 使用固定列宽显示", () => {
  const store = new TranscriptStore();
  appendAssistant(store, "```text\n\tfirst\n\n\t\tsecond\n```");
  const view = new TranscriptView(store);
  const result = view.render({ width: 12, height: 20 });
  const lines = plainLines(result);
  assert.ok(lines.includes("│   first"));
  assert.ok(lines.includes("│     second"));
  view.handlePointer(pointer("down", 2, lines.indexOf("│   first")));
  view.handlePointer(pointer("up", 12, lines.indexOf("│     second")));
  assert.equal(view.selectedText, "\tfirst\n\n\t\tsecond");
  assert.equal(result.lines.some(line => line.includes("\t")), false);
});

test("一万行内容保留有界视口和完整复制来源，销毁后清理选择状态", () => {
  const store = new TranscriptStore();
  store.appendUser(Array.from({ length: 10_050 }, (_, index) => `line ${index}`).join("\n"));
  const view = new TranscriptView(store);
  const scroll = new ScrollView(view, { followEnd: true, maxContentLines: 10_000 });
  const result = scroll.render({ width: 60, height: 10 });
  assert.equal(result.lines.length, 10);
  assert.equal(plainLines(result)[0], "  line 10040");
  scroll.handlePointer(pointer("down", 2, 0));
  scroll.handlePointer(pointer("up", 60, 9));
  assert.equal(view.selectedText, Array.from({ length: 10 }, (_, index) => `line ${10040 + index}`).join("\n"));
  const cached = scroll.render({ width: 60, height: 10 });
  assert.deepEqual(plainLines(cached), plainLines(result));
  scroll.dispose();
  assert.equal(view.hasSelection, false);
});
