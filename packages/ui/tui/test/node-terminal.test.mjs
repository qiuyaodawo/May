import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { createNodeTerminal } from "@sortedyuan/tui/node-terminal";

test("completes suggestions and redraws an active prompt around output", async () => {
  const { terminal, input, output } = createTestTerminal();
  const suggestionInputs = [];
  const answer = terminal.question("> ", {
    history: false,
    suggestions(line) {
      suggestionInputs.push(line);
      return line.startsWith("/") ? [{ value: "/retry", label: "/retry", description: "Retry" }] : [];
    },
  });
  await tick();
  input.write("/re");
  await tick();
  await tick();

  input.write("\t");
  await tick();
  await tick();

  terminal.write("status update\n");
  input.write("\r");

  assert.equal(await answer, "/retry");
  assert.ok(suggestionInputs.includes("/re"));
  assert.match(output(), /\/retry  Retry/u);
  assert.match(output(), /status update\n> \/retry/u);
  await terminal.close();
});

test("keeps temporary answers out of history and normalizes standalone keys", async () => {
  const { terminal, input } = createTestTerminal();
  const approval = terminal.question("approve: ", { history: false });
  await tick();
  input.write("s\r");
  assert.equal(await approval, "s");

  terminal.addHistory("first line\nsecond line");
  const recalled = terminal.question("> ", { history: false });
  await tick();
  input.write("\x1b[A\r");
  assert.equal(await recalled, "first line second line");

  const stroke = terminal.readKey();
  await tick();
  input.write("d");
  assert.deepEqual(await stroke, {
    key: "d",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    text: "d",
  });
  await terminal.close();
});

test("updating the prompt keeps the typed text and cursor position", async () => {
  const { terminal, input, output } = createTestTerminal();
  const answer = terminal.question("> ");
  await tick();
  input.write("abcd\x1b[D\x1b[D");
  await tick();
  terminal.updatePrompt("YOLO · Auto-approve > ");
  terminal.write("YOLO enabled\n");
  assert.match(stripVTControlCharacters(output()), /YOLO · Auto-approve > abcd/u);
  input.write("X\r");
  assert.equal(await answer, "abXcd");
  await terminal.close();
});

test("close waits for an active suggestion provider", async () => {
  const { terminal, input } = createTestTerminal();
  const provider = Promise.withResolvers();
  const started = Promise.withResolvers();
  const answer = terminal.question("> ", {
    suggestions() {
      started.resolve();
      return provider.promise;
    },
  });
  const interrupted = assert.rejects(answer, { name: "AbortError" });
  await tick();
  input.write("a");
  await started.promise;
  let finished = false;
  const closing = terminal.close().then(() => {
    finished = true;
  });
  await interrupted;
  await tick();
  assert.equal(finished, false);
  provider.resolve([]);
  await closing;
  assert.equal(finished, true);
});

test("suggestion failures interrupt input and propagate through close", async () => {
  const { terminal, input } = createTestTerminal();
  const failure = new Error("Completion provider failed");
  const answer = terminal.question("> ", {
    async suggestions() {
      throw failure;
    },
  });
  const interrupted = assert.rejects(answer, { name: "AbortError" });
  await tick();
  input.write("a");
  await interrupted;
  await assert.rejects(terminal.close(), (error) => error instanceof AggregateError && error.errors.includes(failure));
});

function createTestTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  let output = "";
  stream.on("data", (chunk) => (output += chunk.toString()));
  return {
    input,
    terminal: createNodeTerminal({ input, output: stream, colors: false }),
    output: () => output,
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
