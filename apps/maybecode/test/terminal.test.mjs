import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createNodeTerminal } from "../dist/index.js";

test("redraws an active prompt around asynchronous output", async () => {
  const { terminal, input, output } = createTestTerminal();
  const answer = terminal.question("> ", { history: false });
  await tick();
  input.write("draft");
  await tick();

  terminal.write("status update\n");
  input.write("\r");

  assert.equal(await answer, "draft");
  assert.match(output(), /status update\n> draft/u);
  terminal.close();
});

test("keeps approval answers out of history and recalls combined input", async () => {
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
  terminal.close();
});

function createTestTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  let output = "";
  stream.on("data", (chunk) => output += chunk.toString());
  return {
    input,
    terminal: createNodeTerminal({ input, output: stream, colors: false }),
    output: () => output,
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
