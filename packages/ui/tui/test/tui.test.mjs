import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Column, Dialog, Editor, EditorHistory, FocusManager, Markdown, NodeTerminalDriver, ScreenBuffer, ScrollView, SelectList, Text, sanitizeTerminalText } from "../dist/index.js";
import { keyStroke } from "@may/keybindings";

test("neutralizes 7-bit and 8-bit terminal control sequences", () => {
  const safe = sanitizeTerminalText("a\x1b[2Jb\u009b2Jc\u009d0;title\u0007d");
  assert.equal(safe, "a␛[2Jb�2Jc�0;title�d");
});

test("clips rendered lines and cursors to the screen", () => {
  const buffer = ScreenBuffer.from(
    { lines: ["中文abc"], cursor: { x: 20, y: 20 } },
    { width: 5, height: 2 },
  );
  assert.equal(buffer.lines[0], "中文a");
  assert.deepEqual(buffer.cursor, { x: 4, y: 1, visible: true });
});

test("edits grapheme clusters and tracks a wrapped cursor", () => {
  const editor = new Editor({ value: "中a" });
  editor.setFocused(true);
  editor.handleKey(keyStroke("backspace"));
  editor.handleKey(keyStroke("b", { text: "b" }));
  const result = editor.render({ width: 4, height: 3 });
  assert.equal(editor.value, "中b");
  assert.deepEqual(result.lines, ["> 中", "  b"]);
  assert.deepEqual(result.cursor, { x: 3, y: 1, visible: true });
});

test("navigates editor history and handles word edits and multiline paste", () => {
  const history = new EditorHistory({ entries: ["alpha one", "beta two"] });
  const editor = new Editor({ value: "draft", history });
  editor.setFocused(true);

  editor.handleKey(keyStroke("up"));
  assert.equal(editor.value, "beta two");
  editor.handleKey(keyStroke("up"));
  assert.equal(editor.value, "alpha one");
  editor.handleKey(keyStroke("down"));
  editor.handleKey(keyStroke("down"));
  assert.equal(editor.value, "draft");

  editor.setValue("alpha beta");
  editor.handleKey(keyStroke("left", { alt: true }));
  assert.equal(editor.cursor, 6);
  editor.handleKey(keyStroke("w", { ctrl: true }));
  editor.handleKey(keyStroke("paste", { text: "one\n中文" }));
  assert.equal(editor.value, "one\n中文beta");
});

test("decodes bracketed paste as one terminal input operation", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = function setRawMode(enabled) {
    this.isRaw = enabled;
    return this;
  };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  let terminalOutput = "";
  output.on("data", (chunk) => terminalOutput += chunk.toString());

  const driver = new NodeTerminalDriver({ input, output });
  const strokes = [];
  driver.onKey((stroke) => strokes.push(stroke));
  driver.start();
  input.write("\x1b[20");
  input.write("0~first\n中文");
  input.write("\x1b[201~");
  input.write("x");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    strokes.map(({ key, text }) => ({ key, text })),
    [
      { key: "paste", text: "first\n中文" },
      { key: "x", text: "x" },
    ],
  );
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(strokes.at(-1).key, "escape");
  driver.close();
  assert.match(terminalOutput, /\x1b\[\?2004h/u);
  assert.match(terminalOutput, /\x1b\[\?2004l/u);
});

test("moves focus and dispatches only to the active target", () => {
  const calls = [];
  const target = (name) => ({
    setFocused: (focused) => calls.push(`${name}:${focused}`),
    handleKey: () => { calls.push(`${name}:key`); return true; },
  });
  const focus = new FocusManager();
  focus.register("one", target("one"));
  focus.register("two", target("two"));
  focus.focusNext();
  focus.dispatch(keyStroke("enter"));
  assert.equal(focus.focusedId, "two");
  assert.equal(calls.at(-1), "two:key");
});

test("navigates selectable and scrollable content", () => {
  const list = new SelectList([
    { value: "a", label: "A" },
    { value: "b", label: "B", disabled: true },
    { value: "c", label: "C" },
  ]);
  list.setFocused(true);
  list.handleKey(keyStroke("down"));
  assert.equal(list.selectedItem?.value, "c");

  const scroll = new ScrollView(new Text("1\n2\n3\n4"));
  scroll.setFocused(true);
  scroll.render({ width: 4, height: 2 });
  scroll.handleKey(keyStroke("end"));
  assert.deepEqual(scroll.render({ width: 4, height: 2 }).lines, ["3", "4"]);
});

test("anchors column regions and routes modal input", () => {
  const column = new Column([
    { height: 1, component: new Text("header") },
    { flex: 1, component: new Text("body") },
    { height: 1, component: new Text("footer") },
  ]);
  assert.deepEqual(
    column.render({ width: 10, height: 5 }).lines,
    ["header", "body", "", "", "footer"],
  );

  const calls = [];
  const component = (name) => ({
    render: () => ({ lines: [name] }),
    handleKey: () => { calls.push(name); return true; },
  });
  const dialog = new Dialog(component("base"), component("modal"), { open: true });
  dialog.handleKey(keyStroke("enter"));
  dialog.handleKey(keyStroke("escape"));
  dialog.handleKey(keyStroke("enter"));
  assert.deepEqual(calls, ["modal", "base"]);
});

test("renders Markdown without emitting embedded terminal controls", () => {
  const result = new Markdown(
    "# Title\n\n- **bold**\n- `code`\n\n\x1b[2Jdanger",
    { colors: false },
  ).render({ width: 40, height: 10 });
  assert.deepEqual(result.lines.slice(0, 4), [
    "# Title",
    "",
    "• bold",
    "• code",
  ]);
  assert.match(result.lines.join("\n"), /␛\[2Jdanger/u);
});
