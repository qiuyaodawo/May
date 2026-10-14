import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const observer = new URL("./helpers/startup-modules.mjs", import.meta.url).href;

test("CLI 帮助按需加载入口模块，保留正常退出和参数校验", async () => {
  const { stdout, stderr } = await execute(process.execPath, ["--import", observer, bin, "--help"], { windowsHide: true });
  assert.match(stdout, /Usage:\s+maybecode/u);
  assert.equal(stderr, "");
  const recorded = stdout.split("\n").find(line => line.startsWith("MAY_STARTUP_MODULES="));
  assert.ok(recorded);
  const modules = JSON.parse(recorded.slice("MAY_STARTUP_MODULES=".length));
  assert.equal(modules.some(url => /\/(?:configured|retained-tui|tui|team|mcp-auth|web-server|sixel)[.-]/u.test(url)), false);
  assert.equal(modules.some(url => /(?:sharp|jimp|image-q|@modelcontextprotocol)/u.test(url)), false);
  await assert.rejects(execute(process.execPath, [bin, "--ui", "invalid"], { windowsHide: true }), error => {
    assert.equal(error.code, 2);
    assert.match(error.stdout, /--ui must be/u);
    return true;
  });
});
