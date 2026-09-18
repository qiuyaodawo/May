import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { EditorHistory, NodeTerminalDriver } from "@may/tui";
import { MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";

test("mouse input scrolls the transcript while preserving the editor and reading position", (t) => {
  const store = new TranscriptStore();
  store.appendUser(Array.from({ length: 80 }, (_, index) => `message-${index}`).join("\n"));
  const view = new MaybeCodePrototypeView({
    store,
    workspace: "workspace",
    inputHistory: new EditorHistory({ entries: ["previous-command"] }),
    onSubmit() { assert.fail("scrolling must not submit input"); },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const driver = new NodeTerminalDriver({ input, output, requireTTY: false });
  t.after(() => { driver.close(); view.dispose(); });
  driver.onKey((stroke) => view.handleKey(stroke));
  driver.start();
  driver.enterAlternateScreen();
  const render = () => stripVTControlCharacters(view.render({ width: 100, height: 24 }).lines.join("\n"));
  input.write("current-draft");
  const latest = render();
  assert.match(latest, /message-79/u);
  for (let index = 0; index < 10; index++) input.write("\x1b[<64;5;5M");
  const older = render();
  assert.notEqual(older, latest);
  assert.doesNotMatch(older, /message-79/u);
  assert.match(older, /current-draft/u);
  assert.doesNotMatch(older, /previous-command/u);
  store.appendUser("new-message");
  assert.equal(render(), older);
  for (let index = 0; index < 50; index++) input.write("\x1b[<65;5;5M");
  assert.match(render(), /new-message/u);
  store.appendUser("followed-message");
  assert.match(render(), /followed-message/u);
  input.write("\x1b[A");
  assert.match(render(), /previous-command/u);
  input.write("\x1b[B");
  assert.match(render(), /current-draft/u);

  const background = render();
  const cancellation = new AbortController();
  const answer = view.requestMcpInput(
    Array.from({ length: 40 }, (_, index) => `request-${index}`).join("\n"),
    cancellation.signal,
  );
  const dialog = render();
  input.write("\x1b[<65;5;5M");
  assert.notEqual(render(), dialog);
  cancellation.abort();
  assert.match(dialog, /request/u);
  assert.equal(render(), background);
  return answer.then((value) => assert.equal(value, undefined));
});
