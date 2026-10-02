import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLandstripEnvironment } from "@may/environment";
import { createCodingTools, createPowerShellProfile, workspaceFileKey } from "../dist/index.js";

test("read, edit, write, shell and guard use the same real environment", { skip: process.platform !== "win32" }, async () => {
  const review = fileURLToPath(new URL("../../../../review/environment-mvp/tests/", import.meta.url));
  await mkdir(review, { recursive: true });
  const root = await mkdtemp(join(review, "tools-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const sentinel = join(root, "sentinel.txt");
  await writeFile(sentinel, "protected");
  const environment = await createLandstripEnvironment({ workspace });
  const description = await environment.describe();
  const operations = [];
  const tools = createCodingTools({
    cwd: description.workingDirectory,
    environment,
    shell: { profile: createPowerShellProfile({ executable: "powershell.exe" }) },
    guard: async (operation) => {
      assert.equal(operation.path.environmentId, environment.environmentId);
      assert.ok(workspaceFileKey(operation.path).startsWith(environment.environmentId + ":"));
      const result = await operation.run();
      operations.push({ tool: operation.tool, exists: operation.exists, content: result.content });
      return result;
    },
  });
  const progress = [];
  const context = { signal: new AbortController().signal, report: (update) => progress.push(update), runId: "environment-test", step: 1, toolCallId: "environment-test", idempotencyKey: "environment-test" };
  const execute = (name, input) => {
    const tool = tools.find((item) => item.name === name);
    return tool.execute(tool.parse(input), context);
  };
  try {
    assert.equal((await execute("write", { path: "nested/text.txt", content: "\uFEFFfirst\nsecond\n" })).bytesWritten, 16);
    assert.equal((await execute("read", { path: "nested/text.txt", offset: 2, limit: 1 })).content, "second");
    await execute("edit", { path: "nested/text.txt", oldText: "second", newText: "third" });
    assert.equal(await readFile(join(workspace, "nested", "text.txt"), "utf8"), "\uFEFFfirst\nthird\n");
    const shell = await execute("shell", { command: "[IO.File]::ReadAllText('nested/text.txt')" });
    assert.equal(shell.exitCode, 0);
    assert.ok(shell.stdout.includes("third"));
    assert.ok(progress.some((update) => update.type === "output.delta"));
    const denied = await execute("shell", { command: `$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText('${sentinel.replaceAll("'", "''")}', 'changed')` });
    assert.notEqual(denied.exitCode, 0);
    assert.equal(await readFile(sentinel, "utf8"), "protected");
    await assert.rejects(execute("write", { path: "../sentinel.txt", content: "changed" }), { code: "ENVIRONMENT_INVALID_PATH" });
    assert.deepEqual(operations.map((operation) => operation.tool), ["write", "read", "edit"]);
    assert.equal(operations[0].exists, false);
    assert.equal(operations[2].content, "\uFEFFfirst\nthird\n");
    await symlink(join(workspace, "nested"), join(workspace, "alias"), "junction");
    const alias = await execute("read", { path: "alias/text.txt" });
    assert.equal(alias.path, "nested/text.txt");
    assert.equal(alias.content, "\uFEFFfirst\nthird\n");
    await assert.rejects(execute("shell", { command: "Start-Sleep -Seconds 30", timeoutMs: 3000 }), { code: "CODING_TOOL_COMMAND_TIMEOUT" });
  } finally {
    await environment.close();
    await rm(root, { recursive: true });
  }
});
