import assert from "node:assert/strict";
import test from "node:test";
import { SystemClipboard } from "../../dist/clipboard.js";

test("系统剪贴板读写保留 Unicode、缩进和换行", {
  skip: process.env.MAY_TEST_SYSTEM_CLIPBOARD !== "1",
}, async t => {
  const clipboard = new SystemClipboard();
  const previous = await clipboard.readText();
  if (previous === "") {
    t.skip("当前剪贴板没有可恢复的文字内容");
    return;
  }
  try {
    const content = "MaybeCode clipboard verification 中文 🧑‍💻\n  code\n";
    await clipboard.writeText(content);
    assert.equal(await clipboard.readText(), content);
  } finally {
    await clipboard.writeText(previous);
  }
});
