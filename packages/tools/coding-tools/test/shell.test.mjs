import assert from "node:assert/strict";
import test from "node:test";

import { createPowerShellProfile, createShellTool, getShellToolInfo } from "../dist/index.js";
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
  assert.match(tool.inputSchema.properties.command.description, process.platform === "win32" ? /PowerShell/u : /Bash/u);
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

test("PowerShell 保留最后一条命令状态和显式 exit 状态", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cwd = await createWorkspace(t);
  const missingItem = "Get-Item -LiteralPath './missing-shell-input.txt'";
  const cases = [
    { name: "cmdlet 执行成功", command: "Write-Output 'ok'", exitCode: 0 },
    { name: "cmdlet 出现 non-terminating error", command: missingItem, exitCode: 1, error: "missing-shell-input.txt" },
    { name: "cmdlet 出现 terminating error", command: `${missingItem} -ErrorAction Stop`, exitCode: 1, error: "missing-shell-input.txt" },
    { name: "throw 终止执行", command: "throw 'shell status failure'", exitCode: 1, error: "shell status failure" },
    { name: "native process 执行成功", command: nodeCommand("process.exit(0)"), exitCode: 0 },
    { name: "native process 执行失败", command: nodeCommand("process.exit(7)"), exitCode: 7 },
    { name: "显式 exit 返回零状态", command: "exit 0", exitCode: 0 },
    { name: "显式 exit 返回非零状态", command: "exit 12", exitCode: 12 },
    { name: "native process 失败后 cmdlet 执行成功", command: `${nodeCommand("process.exit(7)")}; Write-Output 'recovered'`, exitCode: 0 },
    { name: "cmdlet 失败后其他 cmdlet 执行成功", command: `${missingItem}; Write-Output 'recovered'`, exitCode: 0, error: "missing-shell-input.txt" },
    { name: "native process 成功后 cmdlet 执行失败", command: `${nodeCommand("process.exit(0)")}; ${missingItem}`, exitCode: 1, error: "missing-shell-input.txt" },
    { name: "native process 失败后 cmdlet 执行失败", command: `${nodeCommand("process.exit(7)")}; ${missingItem}`, exitCode: 7, error: "missing-shell-input.txt" },
    { name: "cmdlet 失败后 native process 执行成功", command: `${missingItem}; ${nodeCommand("process.exit(0)")}`, exitCode: 0, error: "missing-shell-input.txt" },
    { name: "native process 失败后显式 exit 返回零状态", command: `${nodeCommand("process.exit(7)")}; exit 0`, exitCode: 0 },
    { name: "cmdlet 成功后 native process 执行失败", command: `Write-Output 'ok'; ${nodeCommand("process.exit(5)")}`, exitCode: 5 },
    { name: "native process 失败并恢复后 cmdlet 执行失败", command: `${nodeCommand("process.exit(7)")}; ${nodeCommand("process.exit(0)")}; ${missingItem}`, exitCode: 1, error: "missing-shell-input.txt" },
  ];
  const defaultProfile = createPowerShellProfile();
  const profiles = new Map([defaultProfile, createPowerShellProfile({ executable: "powershell.exe" })]
    .map((profile) => [profile.executable, profile]));
  for (const [executable, profile] of profiles) {
    await t.test(executable, async (t) => {
      const tool = createShellTool({ cwd, profile });
      for (const entry of cases) {
        await t.test(entry.name, async () => {
          const result = await executeTool(tool, { command: entry.command });
          assert.equal(result.exitCode, entry.exitCode);
          assert.equal(result.signal, null);
          if (entry.error !== undefined) assert.ok(result.stderr.includes(entry.error));
          else assert.equal(result.stderr, "");
        });
      }
    });
  }
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
