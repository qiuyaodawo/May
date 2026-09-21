import assert from "node:assert/strict";
import test from "node:test";

import { Keymap, keyStroke, mergeKeyBindings } from "../dist/index.js";

test("resolves contextual actions and leader sequences", () => {
  const keymap = new Keymap([
    { context: "global", keys: "<leader> l", action: "session.open" },
    { context: "select", keys: "enter", action: "list.accept" },
    { context: "chat", keys: "enter", action: "chat.submit" },
  ]);

  assert.deepEqual(
    keymap.resolve(keyStroke("enter"), ["global", "chat", "select"]),
    { type: "action", action: "list.accept" },
  );
  assert.equal(
    keymap.resolve(keyStroke("x", { ctrl: true }), ["global", "chat"]).type,
    "pending",
  );
  assert.deepEqual(
    keymap.resolve(keyStroke("l", { text: "l" }), ["global", "chat"]),
    { type: "action", action: "session.open" },
  );
});

test("rejects ambiguous bindings within one context", () => {
  assert.throws(
    () => new Keymap([
      { context: "global", keys: "ctrl+x", action: "one" },
      { context: "global", keys: "ctrl+x l", action: "two" },
    ]),
    /Ambiguous keybinding prefix/,
  );
});

test("上下文变化清除未完成的组合键，提示来自展开后的绑定", () => {
  const keymap = new Keymap([
    { context: "global", keys: "<leader> r", action: "reply" },
  ], { leader: "ctrl+g" });
  assert.deepEqual(keymap.keysForAction("reply"), ["ctrl+g r"]);
  assert.equal(keymap.resolve(keyStroke("g", { ctrl: true }), ["global"]).type, "pending");
  assert.equal(keymap.resolve(keyStroke("r"), ["global", "dialog"]).type, "unmatched");
  keymap.resolve(keyStroke("g", { ctrl: true }), ["global"], 100);
  assert.equal(keymap.resolve(keyStroke("r"), ["global"], 1101).type, "unmatched");
});

test("应用覆盖动作和按键时保留其余默认绑定并验证冲突", () => {
  const defaults = [
    { context: "editor", keys: "ctrl+a", action: "selectAll" },
    { context: "editor", keys: "home", action: "lineStart" },
    { context: "editor", keys: "ctrl+c", action: "copy" },
  ];
  const bindings = mergeKeyBindings(defaults, [
    { context: "editor", keys: "ctrl+shift+a", action: "selectAll" },
    { context: "editor", keys: "HOME", action: "copy" },
  ]);
  const keymap = new Keymap(bindings);
  assert.deepEqual(keymap.keysForAction("copy"), ["home"]);
  assert.equal(keymap.resolve(keyStroke("a", { ctrl: true }), ["editor"]).type, "unmatched");
  assert.equal(keymap.resolve(keyStroke("home"), ["editor"]).action, "copy");
});

test("可以关闭组合键超时，显式清除仍然立即生效", () => {
  const bindings = [{ context: "global", keys: "ctrl+g d", action: "details" }];
  const keymap = new Keymap(bindings, { chordTimeoutMs: null });
  assert.equal(keymap.resolve(keyStroke("g", { ctrl: true }), ["global"], 0).type, "pending");
  assert.deepEqual(keymap.resolve(keyStroke("d"), ["global"], 60_000), { type: "action", action: "details" });
  keymap.resolve(keyStroke("g", { ctrl: true }), ["global"], 60_001);
  keymap.reset();
  assert.equal(keymap.resolve(keyStroke("d"), ["global"], 60_002).type, "unmatched");
  assert.throws(() => new Keymap(bindings, { chordTimeoutMs: Infinity }), /finite/);
  assert.throws(() => new Keymap(bindings, { chordTimeoutMs: 0 }), /positive/);
});
