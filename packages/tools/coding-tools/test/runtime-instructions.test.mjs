import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import test from "node:test";
import { ToolRegistry } from "@may/core";

import {
  CodingInstructionsError,
  codingRuntimeInstructions,
  createShellTool,
  getShellToolInfo,
  loadCodingInstructions,
  shellRuntimeInstructions,
} from "../dist/index.js";
import { createWorkspace, executeTool } from "./helpers.mjs";

test("运行环境使用当前系统和真实 shell 工具信息", async (t) => {
  const workspace = await createWorkspace(t);
  const shell = getShellToolInfo(createShellTool({ cwd: workspace }));
  const runtime = codingRuntimeInstructions({
    workspace: relative(process.cwd(), workspace),
    shell,
    sessionOrigin: "resumed session",
    permissionMode: "ask",
  });

  assert.ok(runtime.startsWith(`Workspace: ${resolve(workspace)}\n`));
  const operatingSystem = process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin"
    ? "macOS"
    : process.platform === "linux"
    ? "Linux"
    : process.platform;
  assert.ok(runtime.includes(`Operating system: ${operatingSystem}\n`));
  assert.equal(runtime.split("\n").filter((line) => line === `Shell: ${shell.displayName}`).length, 1);
  assert.ok(runtime.includes("Agent role: main agent\nSession origin: resumed session\nPermission mode: ask"));
  assert.ok(runtime.endsWith(shellRuntimeInstructions(shell)));
  assert.equal(runtime.includes("The shell tool runs"), false);

  const loaded = await loadCodingInstructions({
    workspace,
    defaultSystemInstructions: "You are a coding agent.",
    runtimeInstructions: runtime,
  });
  assert.equal(loaded.runtime.content, runtime);
  assert.ok(loaded.effective.includes(`# Runtime environment\n\n${runtime}`));
});

test("历史会话分支和子 Agent 的环境信息可分别提供", async (t) => {
  const workspace = await createWorkspace(t);
  const runtime = codingRuntimeInstructions({
    workspace,
    agentRole: "sub-agent",
    sessionOrigin: "historical branch",
    assignedRole: "reviewer",
    parentTask: "review-runtime-instructions",
    historicalSource: "runtime-source-session",
  });

  assert.ok(runtime.includes("Agent role: sub-agent\nSession origin: historical branch"));
  assert.ok(runtime.includes("Assigned role: reviewer\nParent task: review-runtime-instructions\nSource session: runtime-source-session"));
  assert.ok(runtime.includes("Workspace files may have changed since that point."));
  assert.ok(runtime.includes("Read current files before relying on historical file contents."));
  assert.equal(runtime.includes("Shell:"), false);
  assert.equal(runtime.includes("Permission mode:"), false);
  assert.equal(runtime.startsWith("#"), false);
});

test("运行环境要求 workspace 路径", () => {
  assert.throws(
    () => codingRuntimeInstructions({ workspace: " " }),
    (error) => error instanceof CodingInstructionsError &&
      error.code === "CODING_INSTRUCTIONS_INVALID_OPTION",
  );
});

test("多次 ToolRegistry snapshot 保留可执行 shell 的环境信息", async (t) => {
  const workspace = await createWorkspace(t);
  const tool = createShellTool({ cwd: workspace });
  const originalInfo = getShellToolInfo(tool);
  let registry = new ToolRegistry([tool]);
  const definitions = registry.definitions();

  for (let count = 0; count < 3; count += 1) {
    registry = registry.snapshot();
    const captured = registry.require("shell");
    const info = getShellToolInfo(captured);
    assert.deepEqual(info, originalInfo);
    assert.deepEqual(registry.definitions(), definitions);
    const runtime = codingRuntimeInstructions({ workspace, shell: info });
    assert.ok(runtime.includes(`Shell: ${originalInfo.displayName}\n`));
    assert.ok(runtime.endsWith(shellRuntimeInstructions(originalInfo)));
    info.displayName = "changed returned copy";
    assert.deepEqual(getShellToolInfo(captured), originalInfo);
  }

  const result = await executeTool(registry.require("shell"), {
    command: process.platform === "win32"
      ? "Write-Output 'snapshot-shell'"
      : "printf 'snapshot-shell\\n'",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.replace(/\r\n/gu, "\n"), "snapshot-shell\n");
});
