import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import AnsiParser from "node-ansiparser";
import { ClipboardUnavailableError, SystemClipboard, createTerminalClipboard } from "../dist/index.js";

test("OSC 52 写入 Unicode 文字并明确报告不支持读取", async () => {
  const output = new PassThrough();
  const commands = [];
  const parser = new AnsiParser({ inst_o: data => commands.push(data) });
  output.on("data", value => parser.parse(value.toString()));
  const clipboard = createTerminalClipboard({ mode: "osc52", output });
  const text = "中文 🧑‍💻\n  code\n";
  await clipboard.writeText(text);
  assert.deepEqual(commands, [`52;c;${Buffer.from(text).toString("base64")}`]);
  await assert.rejects(clipboard.readText(), ClipboardUnavailableError);
});

test("SSH 自动模式和禁用模式不会访问主机系统剪贴板", async () => {
  for (const env of [{ SSH_TTY: "/dev/pts/0" }, { SSH_CONNECTION: "client server" }, { SSH_CLIENT: "client" }]) {
    const clipboard = createTerminalClipboard({ env });
    await assert.rejects(clipboard.readText(), /MAY_CLIPBOARD=osc52/u);
    await assert.rejects(clipboard.writeText("value"), /MAY_CLIPBOARD=osc52/u);
  }
  const disabled = createTerminalClipboard({ env: { MAY_CLIPBOARD: "disabled" } });
  await assert.rejects(disabled.readText(), /disabled/u);
  await assert.rejects(disabled.writeText("value"), /disabled/u);
  assert.throws(() => createTerminalClipboard({ env: { MAY_CLIPBOARD: "invalid" } }), RangeError);
  assert.ok(createTerminalClipboard({ env: {} }) instanceof SystemClipboard);
  assert.ok(createTerminalClipboard({ mode: "system", env: { SSH_TTY: "/dev/pts/0" } }) instanceof SystemClipboard);
});

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
