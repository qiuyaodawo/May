import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestDirectory } from "../packages/test-support/index.mjs";
import { buildNodeTestArgs, DEFAULT_TEST_TIMEOUT_MS, LEAK_GUARD_URL } from "./run-node-tests.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./run-node-tests.mjs", import.meta.url));
const TEST_SUPPORT_URL = pathToFileURL(
  fileURLToPath(new URL("../packages/test-support/index.mjs", import.meta.url)),
).href;

function runGuardedTests(args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, ...args], {
      env: { ...process.env, ...envOverrides },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("buildNodeTestArgs injects leak guard and default timeout unless overridden", () => {
  assert.deepEqual(buildNodeTestArgs(["test/*.test.mjs"], {}), [
    "--test",
    "--import",
    LEAK_GUARD_URL,
    `--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
    "test/*.test.mjs",
  ]);
  assert.deepEqual(buildNodeTestArgs(["--test-timeout=5000", "a.test.mjs"], {}), [
    "--test",
    "--import",
    LEAK_GUARD_URL,
    "--test-timeout=5000",
    "a.test.mjs",
  ]);
  assert.deepEqual(buildNodeTestArgs(["a.test.mjs"], { MAY_TEST_TIMEOUT_MS: "45000" }), [
    "--test",
    "--import",
    LEAK_GUARD_URL,
    "--test-timeout=45000",
    "a.test.mjs",
  ]);
});

test(
  "fails promptly with active handle diagnostics when a test leaks an HTTP server",
  { timeout: 10_000 },
  async (t) => {
    const dir = await createTestDirectory(t, "scripts/leak-guard-http");
    const fixture = join(dir, "leaked-server.test.mjs");
    await writeFile(
      fixture,
      [
        'import { createServer } from "node:http";',
        'import test from "node:test";',
        'test("forgets to close listening server", async () => {',
        "  const server = createServer();",
        '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
        "});",
      ].join("\n"),
      "utf8",
    );

    const started = performance.now();
    const result = await runGuardedTests([fixture], { MAY_TEST_LEAK_GRACE_MS: "250" });
    const elapsed = performance.now() - started;

    assert.notEqual(result.code, 0, "leaking test worker must fail with non-zero exit code");
    assert.ok(elapsed < 4_000, `leak guard must abort promptly instead of hanging, took ${elapsed}ms`);
    const output = result.stdout + result.stderr;
    assert.match(output, /\[test-leak-guard\]/);
    assert.match(output, /TCPServerWrap/);
    assert.match(output, /leaked-server\.test\.mjs/);
  },
);

test("fails promptly when a test leaks a ref'd interval timer", { timeout: 10_000 }, async (t) => {
  const dir = await createTestDirectory(t, "scripts/leak-guard-timer");
  const fixture = join(dir, "leaked-timer.test.mjs");
  await writeFile(
    fixture,
    [
      'import test from "node:test";',
      'test("forgets to clear interval", () => {',
      "  setInterval(() => {}, 60_000);",
      "});",
    ].join("\n"),
    "utf8",
  );

  const result = await runGuardedTests([fixture], { MAY_TEST_LEAK_GRACE_MS: "250" });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.code, 0);
  assert.match(output, /\[test-leak-guard\]/);
  assert.match(output, /Timeout/);
});

test("bounds a test that hangs inside test() while holding an open HTTP server", { timeout: 10_000 }, async (t) => {
  const dir = await createTestDirectory(t, "scripts/leak-guard-hang");
  const fixture = join(dir, "hung-with-server.test.mjs");
  await writeFile(
    fixture,
    [
      'import { createServer } from "node:http";',
      'import test from "node:test";',
      'test("hangs with open server", async () => {',
      "  const server = createServer();",
      '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
      "  await new Promise(() => {});",
      "});",
    ].join("\n"),
    "utf8",
  );

  const started = performance.now();
  const result = await runGuardedTests([fixture], {
    MAY_TEST_TIMEOUT_MS: "200",
    MAY_TEST_LEAK_GRACE_MS: "250",
  });
  const elapsed = performance.now() - started;

  const output = result.stdout + result.stderr;
  assert.notEqual(result.code, 0);
  assert.ok(elapsed < 4_000, `hung test with open server must terminate promptly, took ${elapsed}ms`);
  assert.match(output, /timed out after 200ms/);
  assert.match(output, /TCPServerWrap/);
});

test("passes cleanly with zero extra wait when trackServer() closes the server", { timeout: 10_000 }, async (t) => {
  const dir = await createTestDirectory(t, "scripts/leak-guard-clean");
  const fixture = join(dir, "clean-server.test.mjs");
  await writeFile(
    fixture,
    [
      'import { createServer } from "node:http";',
      'import test from "node:test";',
      `import { trackServer } from ${JSON.stringify(TEST_SUPPORT_URL)};`,
      'test("closes tracked server cleanly", async (t) => {',
      '  const server = trackServer(t, createServer((_req, res) => res.end("ok")));',
      '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
      "  const address = server.address();",
      "  const response = await fetch(`http://127.0.0.1:${address.port}/`);",
      "  await response.text();",
      "});",
    ].join("\n"),
    "utf8",
  );

  const started = performance.now();
  const result = await runGuardedTests([fixture], { MAY_TEST_LEAK_GRACE_MS: "5000" });
  const elapsed = performance.now() - started;

  assert.equal(result.code, 0, `expected clean test to pass: ${result.stderr}\n${result.stdout}`);
  assert.ok(elapsed < 3_000, `clean test must not wait for the 5000ms leak grace timer, took ${elapsed}ms`);
});
