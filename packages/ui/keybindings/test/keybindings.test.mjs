import assert from "node:assert/strict";
import test from "node:test";

import { Keymap, keyStroke } from "../dist/index.js";

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
