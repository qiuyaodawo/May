import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { openConfiguredMaybeCode } from "../../dist/index.js";

const execute = promisify(execFile);
const artifacts = fileURLToPath(new URL("../../../../review/worktree-subscription-tests/", import.meta.url));
const server = fileURLToPath(new URL("../../../../packages/mcp/test/fixtures/workspace-resource-server.mjs", import.meta.url));

test("real MCP subscriptions retain their workspace and Session ownership", {
  timeout: 120_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async t => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "subscriptions-"));
  const workspace = join(directory, "project"); await mkdir(workspace);
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "main");
  assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
  await git("config", "--local", "user.name", "May subscription test");
  await git("config", "--local", "user.email", "may-test@example.invalid");
  await git("config", "--local", "core.autocrlf", "false");
  await writeFile(join(workspace, "value.txt"), "INITIAL_SUBSCRIPTION\n");
  const app = await openConfiguredMaybeCode({ workspace, model: "deepseek-v4-flash",
    dataDirectory: join(directory, "sessions"), skills: false, goals: false, subagents: false,
    observability: false, plugins: [], permissionMode: "yolo",
    mcp: { servers: [{ id: "workspace", command: process.execPath, args: [server], required: true, protocolMode: "auto" }] },
    instructions: "Use write to apply the exact requested content. Do not run shell commands. Keep the answer short.",
    git: { dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), authorizeCommit(request) {
      assert.ok(resolve(request.workspace) === resolve(workspace) || resolve(request.workspace).startsWith(`${resolve(directory, "worktrees")}${sep}`));
      return true;
    } },
  });
  t.after(async () => { await app.close(); assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`)); await rm(directory, { recursive: true, force: true }); });
  const first = await app.submit({ input: "Write value.txt containing exactly HISTORICAL_SUBSCRIPTION followed by a newline." });
  await first.result;
  const originalId = app.sessionId;
  const point = (await app.getForkPoints(originalId)).find(item => item.runId === first.id);
  assert.ok(point.worktreeAvailable);
  const original = await app.watchMcpResource("workspace", "workspace:///value");
  let originalClosed = false; void original.closed.then(() => { originalClosed = true; });
  await app.forkSession(point.id, "current");
  const sameWorkspace = await app.watchMcpResource("workspace", "workspace:///value");
  assert.notEqual(sameWorkspace, original);
  await app.unwatchMcpResource("workspace", "workspace:///value");
  assert.equal(await sameWorkspace.closed, "local"); assert.equal(originalClosed, false);
  await writeFile(join(workspace, "value.txt"), "CURRENT_SUBSCRIPTION\n");
  const inherited = (await app.getForkPoints(app.sessionId)).find(item => item.runId === first.id);
  await app.forkSession(inherited.id, "worktree");
  const historical = await app.watchMcpResource("workspace", "workspace:///value");
  assert.notEqual(historical, original);
  const read = await app.readMcpResource("workspace", "workspace:///value");
  assert.equal(read.result.contents[0].text, "HISTORICAL_SUBSCRIPTION\n");
  await app.unwatchMcpResource("workspace", "workspace:///value");
  assert.equal(await historical.closed, "local"); assert.equal(originalClosed, false);
  await app.resumeSession(originalId);
  assert.equal(await app.watchMcpResource("workspace", "workspace:///value"), original);
  assert.equal((await app.readMcpResource("workspace", "workspace:///value")).result.contents[0].text, "CURRENT_SUBSCRIPTION\n");
  await app.unwatchMcpResource("workspace", "workspace:///value");
  assert.equal(await original.closed, "local");
});
