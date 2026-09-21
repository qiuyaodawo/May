import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { NodeTerminalDriver } from "@may/tui";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";

function open(t, width = 80) {
  const store = new TranscriptStore();
  store.appendUser("question\n".repeat(20));
  const message = { role: "assistant", content: [{ type: "text", text:
    "# Heading\n\n" + Array.from({ length: 35 }, (_, index) => `line-${index}: ${"text ".repeat(9)}`).join("\n") +
    "\n\n```ts\n" + " ".repeat(150) + "code\n\n" + "  value\n".repeat(35) + "```" }] };
  store.applyMayEvent({ type: "model.completed", runId: "run", step: 1, seq: 1,
    timestamp: 1, contextMessageCount: 1, message });
  const submitted = [];
  const view = new MaybeCodePrototypeView({ store, workspace: "workspace", onSubmit: value => submitted.push(value) });
  const input = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output: new PassThrough(), requireTTY: false });
  driver.onKey(stroke => view.handleKey(stroke));
  driver.start();
  driver.enterAlternateScreen();
  t.after(() => { driver.close(); view.dispose(); });
  const render = () => view.render({ width, height: 24 }).lines.map(stripVTControlCharacters);
  const waitForKey = name => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Missing key: ${name}`)); }, 2_000);
    const unsubscribe = driver.onKey(stroke => {
      if (stroke.key !== name) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
  return { input, render, submitted, waitForKey };
}

test("会话焦点下等待组合键不会改变阅读位置", t => {
  for (const width of [20, 40, 80]) {
    const terminal = open(t, width);
    terminal.input.write("\t");
    terminal.render();
    terminal.input.write("\x1b[H");
    terminal.render();
    for (let index = 0; index < 130; index++) {
      terminal.input.write("\x1b[B");
      const before = terminal.render().slice(3, 19);
      terminal.input.write("\x07");
      assert.deepEqual(terminal.render().slice(3, 19), before, `width=${width}, row=${index}`);
      terminal.input.write("\x1b");
    }
  }
});

test("输入框组合键允许阅读提示后继续输入动作", async t => {
  const terminal = open(t);
  terminal.input.write("draft\x07");
  assert.match(terminal.render().at(-1), /Shortcut/);
  await delay(1_100);
  terminal.input.write("d");
  assert.match(terminal.render().at(-1), /Tool details shown/);
  terminal.input.write("\r");
  assert.deepEqual(terminal.submitted, ["draft"]);
});

test("Escape 取消组合键并清除提示，后续字母继续编辑草稿", async t => {
  const terminal = open(t);
  terminal.input.write("draft\x07");
  assert.match(terminal.render().at(-1), /Shortcut/);
  const escaped = terminal.waitForKey("escape");
  terminal.input.write("\x1b");
  await escaped;
  assert.doesNotMatch(terminal.render().at(-1), /Shortcut/);
  terminal.input.write("d\r");
  assert.deepEqual(terminal.submitted, ["draftd"]);
});

test("会话焦点下可以在等待后完成组合键，切换焦点会结束等待", async t => {
  const terminal = open(t);
  terminal.input.write("draft\t");
  const before = terminal.render().slice(3, 19);
  terminal.input.write("\x07");
  assert.deepEqual(terminal.render().slice(3, 19), before);
  await delay(1_100);
  terminal.input.write("d");
  assert.match(terminal.render().at(-1), /Tool details shown/);
  terminal.input.write("\x07\t");
  assert.doesNotMatch(terminal.render().at(-1), /Shortcut/);
  terminal.input.write("d\r");
  assert.deepEqual(terminal.submitted, ["draftd"]);
});
