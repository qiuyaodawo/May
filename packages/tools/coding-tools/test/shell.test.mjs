import assert from "node:assert/strict";
import test from "node:test";

import { createShellTool, getShellToolInfo } from "../dist/index.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("shell uses the platform syntax and preserves UTF-8 output", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createShellTool({ cwd });
  const progress = [];

  const result = await executeTool(tool, {
    command: `${unicodeOutputCommand()}; ${nodeCommand(
      "process.stdout.write('out');process.stderr.write('err');process.exitCode=3",
    )}`,
  }, undefined, (update) => progress.push(update));

  assert.equal(result.stdout.replace(/\r\n/gu, "\n"), "中文\nout");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  assert.equal(progress.filter((update) => update.channel === "stdout")
    .map((update) => update.delta).join("").replace(/\r\n/gu, "\n"),
  "中文\nout");
  assert.equal(progress.filter((update) => update.channel === "stderr")
    .map((update) => update.delta).join(""), "err");
  assert.equal(
    getShellToolInfo(tool).kind,
    process.platform === "win32" ? "powershell" : "bash",
  );
  assert.match(tool.description, process.platform === "win32" ? /PowerShell/u : /Bash/u);
});

test("shell truncates captured output without stopping the command", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createShellTool({ cwd, maxOutputBytes: 3 });

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

test("shell rejects commands that exceed their timeout", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createShellTool({
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

test("shell responds to cancellation", async (t) => {
  const cwd = await createWorkspace(t);
  const controller = new AbortController();
  const execution = executeTool(createShellTool({ cwd }), {
    command: nodeCommand("setTimeout(()=>{},1000)"),
  }, controller.signal);
  setTimeout(() => controller.abort("stop"), 30);

  await assert.rejects(
    execution,
    assertErrorCode("CODING_TOOL_CANCELLED"),
  );
});

test("shell validates timeout configuration and input", async (t) => {
  const cwd = await createWorkspace(t);
  assert.throws(
    () => createShellTool({ cwd, defaultTimeoutMs: 20, maxTimeoutMs: 10 }),
    /defaultTimeoutMs must not exceed maxTimeoutMs/,
  );
  const tool = createShellTool({
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
  const encoded = Buffer.from(source).toString("base64");
  const program = `eval(Buffer.from('${encoded}','base64').toString())`;
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' -e "${program}"`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e "${program}"`;
}

function unicodeOutputCommand() {
  return process.platform === "win32"
    ? "Write-Output '中文'"
    : "printf '中文\\n'";
}
