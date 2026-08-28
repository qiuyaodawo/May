import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("runs the built MaybeCode help command", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["dist/bin.js", "--help"],
    { cwd: new URL("..", import.meta.url) },
  );

  assert.match(stdout, /Usage:\s+maybecode/u);
  assert.equal(stderr, "");
});
