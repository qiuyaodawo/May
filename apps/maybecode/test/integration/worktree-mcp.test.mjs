import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ProjectGitWorkspace } from "@may/application/git-workspace";
import { openConfiguredMaybeCode } from "../../dist/index.js";

const execute = promisify(execFile);
const artifacts = fileURLToPath(new URL("../../../../review/worktree-mcp-tests/", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/workspace-files-server.mjs", import.meta.url));

test("configured MCP processes use the selected historical worktree directory", {
  timeout: 180_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async t => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "workspace-"));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "main");
  assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
  await git("config", "--local", "user.name", "May MCP test");
  await git("config", "--local", "user.email", "may-test@example.invalid");
  await writeFile(join(workspace, "value.txt"), "ORIGINAL_MCP_CONTENT\n");
  const app = await openConfiguredMaybeCode({ workspace, model: "deepseek-v4-flash",
    dataDirectory: join(directory, "sessions"), skills: false, goals: false, subagents: false,
    observability: false, plugins: [], permissionMode: "yolo",
    mcp: { servers: [{ id: "workspace", command: process.execPath, args: [server], required: true, protocolMode: "auto" }] },
    instructions: "Follow the exact requested file content. Use mcp__workspace__read for reading value.txt. Use the built-in write tool for editing. Do not run shell commands. Keep the final answer to the file content read.",
    git: { dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), authorizeCommit(request) {
      assert.ok(resolve(request.workspace) === resolve(workspace) || resolve(request.workspace).startsWith(`${resolve(directory, "worktrees")}${sep}`));
      return true;
    } },
  });
  t.after(async () => {
    await app.close();
    assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const first = await app.submit({ input: "Read value.txt using mcp__workspace__read. Then write value.txt containing exactly HISTORICAL_MCP_CONTENT followed by a newline. Report the content you originally read." });
  assert.match(JSON.stringify((await first.result).message), /ORIGINAL_MCP_CONTENT/u);
  const point = (await app.getForkPoints()).find(item => item.runId === first.id);
  assert.equal(point.worktreeAvailable, true);
  const second = await app.submit({ input: "Write value.txt containing exactly CURRENT_MCP_CONTENT followed by a newline." });
  await second.result;
  const originalId = app.sessionId;
  await app.forkSession(point.id, "worktree");
  assert.notEqual(app.workspace, workspace);
  assert.equal((await readFile(join(workspace, "value.txt"), "utf8")).trim(), "CURRENT_MCP_CONTENT");
  const historical = await app.submit({ input: "Read value.txt using mcp__workspace__read and answer with its exact current content. Do not modify files." });
  assert.match(JSON.stringify((await historical.result).message), /HISTORICAL_MCP_CONTENT/u);
  await app.resumeSession(originalId);
  const current = await app.submit({ input: "Read value.txt using mcp__workspace__read and answer with its exact current content. Do not modify files." });
  assert.match(JSON.stringify((await current.result).message), /CURRENT_MCP_CONTENT/u);
  const tree = (await app.getWorktrees())[0];
  let missingResource;
  await assert.rejects(readFile(join(tree.path, "required-host-resource.json")), error => {
    missingResource = error;
    return error.code === "ENOENT";
  });
  const records = await ProjectGitWorkspace.open({ workspace, dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees") });
  await records.failWorktree(tree.id, missingResource);
  const failedPoints = await app.getForkPoints(tree.sessionIds[0]);
  assert.ok(failedPoints.length > 0);
  assert.equal(failedPoints.every(item => !item.available && !item.worktreeAvailable), true);
  assert.match(failedPoints[0].reason, /worktree did not finish initialization/u);
  await assert.rejects(app.openWorktree(tree.id), /Managed worktree is unavailable/u);
});
