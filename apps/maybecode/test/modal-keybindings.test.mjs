import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { keyStroke } from "@may/keybindings";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";
import { createMaybeCodeKeymap } from "../dist/keymap.js";

const key = (view, name, modifiers = {}) => view.handleKey(keyStroke(name, modifiers));
const paste = (view, text) => key(view, "paste", { text });
const render = view => view.render({ width: 100, height: 28 }).lines.map(stripVTControlCharacters);

function viewFor(t, options = {}) {
  const view = new MaybeCodePrototypeView({
    store: new TranscriptStore(), workspace: "workspace",
    onSubmit: () => assert.fail("弹窗不能提交 Agent 输入"), ...options,
  });
  t.after(() => view.dispose());
  return view;
}

function approval() {
  return {
    id: "permission", createdAt: 1, grantKey: "read:workspace",
    tool: { name: "read", description: "Read a file", inputSchema: {} },
    input: { path: "README.md" },
    context: {
      runId: "run", step: 1, toolCallId: "call", idempotencyKey: "request",
      signal: new AbortController().signal,
      report: () => assert.fail("权限界面不能执行工具"),
    },
  };
}

const sessions = [
  { id: "current", workspace: "workspace", createdAt: 1, lastUsedAt: 2, title: "Current" },
  { id: "saved", workspace: "workspace", createdAt: 1, lastUsedAt: 1, title: "Saved 中文" },
];

const models = [
  { name: "first", provider: "local", adapter: "openai-responses", model: "first-model", isDefault: true },
  { name: "second", provider: "local", adapter: "openai-responses", model: "second-model", isDefault: false },
];

test("连续组合键起始按键不能占用输入框的已有编辑操作", () => {
  for (const leader of ["ctrl+a", "ctrl+c", "ctrl+x", "ctrl+v", "ctrl+e", "alt+left", "ctrl+shift+home"]) {
    assert.throws(() => createMaybeCodeKeymap({ leader }), /conflicts with a text editing shortcut/u);
  }
});

test("权限弹窗准确匹配修饰键并使用应用覆盖绑定", async t => {
  const view = viewFor(t, { keymap: { bindings: [
    { context: "approval", keys: "ctrl+y", action: "approval.allow" },
  ] } });
  const result = view.requestApproval(approval());
  assert.match(render(view).join("\n"), /ctrl\+y/u);
  assert.equal(key(view, "a", { ctrl: true }), false);
  assert.equal(key(view, "a", { text: "a" }), false);
  assert.equal(key(view, "s", { ctrl: true }), false);
  assert.equal(key(view, "enter", { shift: true }), false);
  assert.match(render(view).join("\n"), /Allow once/u);
  key(view, "y", { ctrl: true });
  assert.equal(await result, "allow");
});

test("模型弹窗通过语义动作支持列表连续组合键", async t => {
  const view = viewFor(t, { keymap: { bindings: [
    { context: "select", keys: "ctrl+q n", action: "list.down" },
    { context: "select", keys: "ctrl+q a", action: "list.accept" },
  ] } });
  const result = view.requestModelAction(models, "first");
  render(view);
  key(view, "q", { ctrl: true });
  key(view, "n", { text: "n" });
  key(view, "q", { ctrl: true });
  key(view, "a", { text: "a" });
  assert.deepEqual(await result, { type: "switch", profile: "second" });
});

test("模型弹窗将鼠标点击传递给列表并保留键盘选择", async t => {
  const view = viewFor(t);
  const result = view.requestModelAction(models, "first");
  const lines = render(view);
  const row = lines.findIndex(line => line.includes("second-model"));
  assert.ok(row >= 0);
  assert.equal(view.handlePointer({ type: "down", x: 14, y: row, button: 0, ctrl: false, alt: false, shift: false }), true);
  view.handlePointer({ type: "up", x: 14, y: row, button: 0, ctrl: false, alt: false, shift: false });
  key(view, "enter");
  assert.deepEqual(await result, { type: "switch", profile: "second" });
});

test("会话重命名使用完整 Editor 选择与修改操作", async t => {
  const view = viewFor(t, { keymap: { bindings: [
    { context: "sessionPicker", keys: "ctrl+r", action: "session.rename.start" },
  ] } });
  const result = view.requestSessionAction(sessions, "current");
  render(view);
  key(view, "down");
  key(view, "r", { ctrl: true });
  assert.match(render(view).join("\n"), /Rename selected session/u);
  key(view, "a", { ctrl: true });
  paste(view, "新标题🙂");
  key(view, "home");
  key(view, "right", { shift: true });
  paste(view, "已改");
  key(view, "end");
  key(view, "enter");
  assert.deepEqual(await result, { type: "rename", sessionId: "saved", title: "已改标题🙂" });
});

test("会话删除确认准确匹配修饰键", async t => {
  const view = viewFor(t);
  const result = view.requestSessionAction(sessions, "current");
  render(view);
  key(view, "down");
  key(view, "d", { text: "d" });
  assert.equal(key(view, "y", { ctrl: true }), false);
  assert.match(render(view).join("\n"), /Delete Saved 中文/u);
  key(view, "y", { text: "y" });
  assert.deepEqual(await result, { type: "delete", sessionId: "saved" });
});

test("会话搜索允许输入框 Home End 选择并应用搜索上下文的列表绑定", async t => {
  const view = viewFor(t, { keymap: { bindings: [
    { context: "sessionSearch", keys: "ctrl+n", action: "list.down" },
  ] } });
  const result = view.requestSessionAction(sessions, "current");
  render(view);
  key(view, "/", { text: "/" });
  paste(view, "wrong");
  key(view, "home");
  key(view, "end", { shift: true });
  paste(view, "Saved");
  assert.match(render(view).join("\n"), /Search sessions: Saved/u);
  key(view, "u", { ctrl: true });
  key(view, "n", { ctrl: true });
  key(view, "enter");
  assert.deepEqual(await result, { type: "resume", sessionId: "saved" });
});

test("MCP 输入弹窗保留文字选择和多行操作并准确匹配取消按键", async t => {
  const view = viewFor(t);
  const result = view.requestMcpInput("Enter a description", new AbortController().signal);
  render(view);
  assert.equal(key(view, "escape", { ctrl: true }), false);
  paste(view, "first");
  key(view, "a", { ctrl: true });
  paste(view, "中文🙂");
  key(view, "enter", { shift: true });
  paste(view, "second");
  key(view, "enter");
  assert.equal(await result, "中文🙂\nsecond");
});
