import assert from "node:assert/strict";
import test from "node:test";
import { runMaybeCode } from "../dist/index.js";

test("CLI returns usage errors without opening an application", async () => {
  let output = "",
    closed = false,
    opened = false;
  const terminal = {
    colors: false,
    write(text) {
      output += text;
    },
    close() {
      closed = true;
    },
  };
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
