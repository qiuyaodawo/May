import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { NodeTerminalDriver } from "@may/tui";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";

function openView(t, store) {
  const view = new MaybeCodePrototypeView({
    store,
    workspace: "workspace",
    onSubmit() { assert.fail("navigation must not submit the draft"); },
  });
  const input = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output: new PassThrough(), requireTTY: false });
  driver.onKey((stroke) => view.handleKey(stroke));
  driver.start();
  driver.enterAlternateScreen();
  t.after(() => { driver.close(); view.dispose(); });
  return {
    input,
    view,
    jump() { input.write("\x07r"); },
    render(width = 100, height = 24) {
      return view.render({ width, height }).lines.map(stripVTControlCharacters);
    },
  };
}

function completeReply(store, text, runId = "run-1", reasoning = "FINAL-THINKING\n".repeat(40)) {
  const base = { runId, step: 2, timestamp: 1 };
  const message = { role: "assistant", content: [
    { type: "reasoning", text: reasoning }, { type: "text", text },
  ] };
  store.applyMayEvent({ ...base, seq: 10, type: "model.completed", message, contextMessageCount: 4 });
  store.applyMayEvent({ ...base, seq: 11, type: "run.completed", result: {
    runId, steps: 2, modelCalls: 2, toolCalls: 1, message,
  } });
}

test("jumps to final Markdown body through terminal input and preserves draft, focus and reading position", (t) => {
  const store = new TranscriptStore();
  store.appendUser("question");
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, seq: 1, type: "run.started" });
  store.applyMayEvent({ ...base, seq: 2, type: "model.completed", contextMessageCount: 2, message: {
    role: "assistant", content: [{ type: "text", text: "TOOL-PREAMBLE" }],
    toolCalls: [{ id: "call-1", name: "read", input: { path: "notes.md" } }],
  } });
  store.applyMayEvent({ ...base, seq: 3, type: "tool.completed",
    call: { id: "call-1", name: "read", input: { path: "notes.md" } }, output: "TOOL-OUTPUT\n".repeat(50) });
  completeReply(store, "# REPLY-START\n\n" + "正文内容需要自动换行。".repeat(400));
  const terminal = openView(t, store);
  terminal.input.write("draft");
  assert.doesNotMatch(terminal.render().join("\n"), /REPLY-START/u);
  terminal.jump();
  const lines = terminal.render();
  assert.match(lines[3], /REPLY-START/u);
  assert.doesNotMatch(lines.slice(3, 19).join("\n"), /THINKING|TOOL-PREAMBLE|TOOL-OUTPUT/u);
  assert.match(lines.join("\n"), /draft/u);
  terminal.input.write("!");
  assert.match(terminal.render().join("\n"), /draft!/u);
  terminal.jump();
  assert.match(terminal.render()[3], /REPLY-START/u);
  store.appendNotice("info", "LATER-NOTICE");
  assert.match(terminal.render()[3], /REPLY-START/u);
  assert.match(terminal.render(45)[3], /REPLY-START/u);
  terminal.input.write("\x07t");
  assert.match(terminal.render(45)[3], /REPLY-START/u);
  terminal.input.write("\x07t");
  assert.match(terminal.render(45)[3], /REPLY-START/u);
  terminal.input.write("\x1b[<65;5;5M");
  assert.doesNotMatch(terminal.render(45)[3], /REPLY-START/u);
  terminal.jump();
  assert.match(terminal.render(45)[3], /REPLY-START/u);
  terminal.input.write("\t");
  terminal.jump();
  assert.match(terminal.render()[3], /REPLY-START/u);
  terminal.input.write("\x1b[F");
  assert.match(terminal.render().join("\n"), /LATER-NOTICE/u);
});

test("places short replies at the top and retains the start of replies beyond the normal buffer", (t) => {
  const store = new TranscriptStore();
  completeReply(store, "SHORT-REPLY");
  const terminal = openView(t, store);
  terminal.render();
  terminal.jump();
  assert.equal(terminal.render()[3], "SHORT-REPLY");
  assert.equal(terminal.render(40, 16)[3], "SHORT-REPLY");

  store.appendUser("long question");
  completeReply(store, Array.from({ length: 10_050 }, (_, index) => `reply-line-${index}`).join("\n"), "run-2");
  terminal.input.write("\t\x1b[F");
  assert.match(terminal.render().join("\n"), /reply-line-10049/u);
  terminal.jump();
  assert.equal(terminal.render()[3], "reply-line-0");
  terminal.input.write("\x1b[6~");
  assert.equal(terminal.render()[3], "reply-line-16");
  terminal.input.write("\x1b[F");
  assert.match(terminal.render().join("\n"), /reply-line-10049/u);
  store.appendNotice("info", "NOTICE\n".repeat(10_100));
  terminal.jump();
  assert.equal(terminal.render()[3], "reply-line-0");
});

test("waits for the current final reply and keeps modal input isolated", async (t) => {
  const store = new TranscriptStore();
  completeReply(store, "OLD-REPLY");
  const terminal = openView(t, store);
  terminal.render();
  store.appendUser("new question");
  const base = { runId: "run-2", step: 1, timestamp: 2 };
  store.applyMayEvent({ ...base, seq: 1, type: "run.started" });
  store.applyMayEvent({ ...base, seq: 2, type: "model.text.delta", delta: "INTERMEDIATE-TEXT" });
  terminal.jump();
  assert.match(terminal.render().join("\n"), /No final reply yet/u);
  assert.equal(store.latestReply, undefined);
  store.applyMayEvent({ ...base, seq: 3, type: "run.failed", error: { name: "Error", message: "failure" } });
  terminal.jump();
  assert.match(terminal.render().join("\n"), /No final reply yet/u);
  completeReply(store, "CURRENT-REPLY", "run-2");
  const cancellation = new AbortController();
  const answer = terminal.view.requestMcpInput("review request", cancellation.signal);
  terminal.jump();
  assert.match(terminal.render().join("\n"), /review request/u);
  cancellation.abort();
  assert.equal(await answer, undefined);
  terminal.jump();
  assert.equal(terminal.render()[3], "CURRENT-REPLY");
  store.reset("other-session");
  terminal.jump();
  assert.match(terminal.render().join("\n"), /No final reply yet/u);
});

test("restores the final reply from durable history and excludes empty completed output", (t) => {
  const store = new TranscriptStore();
  const message = { role: "assistant", content: [
    { type: "reasoning", text: "history thinking\n".repeat(50) },
    { type: "text", text: "HISTORY-REPLY\n".repeat(50) },
  ] };
  const base = { sessionId: "session-1", runId: "run-1", timestamp: 1 };
  const history = [
    { ...base, seq: 1, type: "run.started" },
    { ...base, seq: 2, type: "assistant.completed", step: 1, message },
    { ...base, seq: 3, type: "run.completed", result: {
      runId: "run-1", steps: 1, modelCalls: 1, toolCalls: 0, message,
    } },
  ];
  store.loadHistory(history);
  const terminal = openView(t, store);
  terminal.render();
  terminal.jump();
  assert.equal(terminal.render()[3], "HISTORY-REPLY");
  store.loadHistory([...history, { ...base, runId: "run-2", seq: 4, type: "run.started" }]);
  terminal.jump();
  assert.match(terminal.render().join("\n"), /No final reply yet/u);
  completeReply(store, "  ", "run-2");
  terminal.jump();
  assert.match(terminal.render().join("\n"), /No final reply yet/u);
});
