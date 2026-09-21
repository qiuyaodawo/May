import assert from "node:assert/strict";
import test from "node:test";
import { keyStroke } from "@may/keybindings";
import { Editor } from "../../dist/editor.js";
import { SystemClipboard } from "../../dist/clipboard.js";

test("使用实际系统剪贴板复制、剪切、粘贴并拒绝过期编辑", {
  skip: process.env.MAY_TEST_SYSTEM_CLIPBOARD !== "1",
}, async () => {
  const clipboard = new SystemClipboard();
  const previous = await clipboard.readText();
  try {
    const input = new Editor({ value: "中文🙂\ntext", clipboard });
    input.setFocused(true);
    input.selectAll();
    input.handleKey(keyStroke("c", { ctrl: true }));
    await input.waitForPendingClipboard();
    assert.equal(await clipboard.readText(), "中文🙂\ntext");
    assert.equal(input.value, "中文🙂\ntext");
    input.handleKey(keyStroke("x", { ctrl: true }));
    await input.waitForPendingClipboard();
    assert.equal(input.value, "");
    input.handleKey(keyStroke("v", { ctrl: true }));
    await input.waitForPendingClipboard();
    assert.equal(input.value, "中文🙂\ntext");
    input.selectAll();
    await clipboard.writeText("替换");
    input.handleKey(keyStroke("v", { ctrl: true }));
    await input.waitForPendingClipboard();
    assert.equal(input.value, "替换");
    input.selectAll();
    input.handleKey(keyStroke("x", { ctrl: true }));
    input.setValue("新的草稿");
    await input.waitForPendingClipboard();
    assert.equal(input.value, "新的草稿");
    assert.equal(await clipboard.readText(), "替换");
    input.handleKey(keyStroke("v", { ctrl: true }));
    input.setValue("继续编辑");
    await input.waitForPendingClipboard();
    assert.equal(input.value, "继续编辑");
    input.handleKey(keyStroke("v", { ctrl: true }));
    input.dispose();
    await input.waitForPendingClipboard();
    assert.equal(input.value, "继续编辑");
  } finally {
    await clipboard.writeText(previous);
  }
});
