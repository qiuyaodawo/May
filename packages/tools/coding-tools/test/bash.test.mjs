import assert from "node:assert/strict";
import test from "node:test";

import { createBashTool } from "../dist/index.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("bash captures stdout, stderr, and a non-zero exit code", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createBashTool({ cwd });
  const progress = [];

  const result = await executeTool(tool, {
    command: nodeCommand(
      "process.stdout.write('out');process.stderr.write('err');process.exitCode=3",
    ),
  }, undefined, (update) => progress.push(update));

  assert.deepEqual(result, {
    stdout: "out",
    stderr: "err",
    exitCode: 3,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.equal(progress.filter((update) => update.channel === "stdout")
    .map((update) => update.delta).join(""), "out");
  assert.equal(progress.filter((update) => update.channel === "stderr")
    .map((update) => update.delta).join(""), "err");
});

test("bash truncates captured output without stopping the command", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createBashTool({ cwd, maxOutputBytes: 3 });

  const result = await executeTool(tool, {
    command: nodeCommand(
      "process.stdout.write('abcdef');process.stderr.write('12345')",
    ),
  });

  assert.equal(result.stdout, "abc");
  assert.equal(result.stderr, "123");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.exitCode, 0);
});

test("bash rejects commands that exceed their timeout", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createBashTool({
    cwd,
    defaultTimeoutMs: 50,
    maxTimeoutMs: 1000,
  });

  await assert.rejects(
    executeTool(tool, {
      command: nodeCommand("setTimeout(()=>{},1000)"),
    }),
    assertErrorCode("CODING_TOOL_COMMAND_TIMEOUT"),
  );
});

test("bash responds to cancellation", async (t) => {
  const cwd = await createWorkspace(t);
  const controller = new AbortController();
  const execution = executeTool(createBashTool({ cwd }), {
    command: nodeCommand("setTimeout(()=>{},1000)"),
  }, controller.signal);
  setTimeout(() => controller.abort("stop"), 30);

  await assert.rejects(
    execution,
    assertErrorCode("CODING_TOOL_CANCELLED"),
  );
});

test("bash validates timeout configuration and input", async (t) => {
  const cwd = await createWorkspace(t);
  assert.throws(
    () => createBashTool({ cwd, defaultTimeoutMs: 20, maxTimeoutMs: 10 }),
    /defaultTimeoutMs must not exceed maxTimeoutMs/,
  );
  const tool = createBashTool({
    cwd,
    defaultTimeoutMs: 10,
    maxTimeoutMs: 10,
  });
  assert.throws(
    () => tool.parse({ command: "echo ok", timeoutMs: 11 }),
    assertErrorCode("CODING_TOOL_INVALID_INPUT"),
  );
});

function nodeCommand(source) {
  return `"${process.execPath}" -e "${source}"`;
}
