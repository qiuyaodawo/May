import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createNodeTerminal } from "../dist/index.js";

test("redraws an active prompt around asynchronous output", async () => {
  const { terminal, input, output } = createTestTerminal();
  const suggestionInputs = [];
  const answer = terminal.question("> ", {
    history: false,
    suggestions(line) {
      suggestionInputs.push(line);
      return line.startsWith("/")
        ? [{ value: "/retry", label: "/retry", description: "Retry" }]
        : [];
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

  const common = terminal.question("> ", {
    history: false,
    suggestions(line) {
      return line.startsWith("/comm")
        ? [{ value: "/commanda" }, { value: "/commandb" }]
        : [];
    },
  });
  await tick();
  input.write("/comm\t");
  await tick();
  await tick();
  input.write("\r");
  assert.equal(await common, "/command");

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
  const nextStroke = terminal.readKey();
  await tick();
  input.write("r");
  assert.equal((await nextStroke).key, "r");
  const escape = terminal.readKey();
  await tick();
  input.write("\x1b");
  assert.deepEqual(await escape, {
    key: "escape",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  await tick();
  const afterKeys = terminal.question("> ");
  await tick();
  input.write("/quit\r");
  assert.equal(await afterKeys, "/quit");
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
