import assert from "node:assert/strict";
import test from "node:test";
import { runMaybeCode } from "../dist/index.js";

test("CLI returns usage errors without opening an application", async () => {
  let output = "", closed = false, opened = false;
  const terminal = { colors: false, write(text) { output += text; }, close() { closed = true; } };
  const exitCode = await runMaybeCode(["--continue", "--resume", "one"], {
    terminal,
    async open() {
      opened = true;
      throw new Error("unreachable");
    },
  });
  assert.equal(exitCode, 2);
  assert.equal(opened, false);
  assert.match(output, /cannot be used together/);
  assert.ok(closed);
});

test("CLI accepts only the retained and Web interfaces", async () => {
  let output = "";
  const terminal = { colors: false, write(text) { output += text; }, close() {} };
  assert.equal(await runMaybeCode(["--ui", "classic"], { terminal, async open() { throw new Error("unreachable"); } }), 2);
  assert.match(output, /--ui must be "retained" or "web"/);
});
