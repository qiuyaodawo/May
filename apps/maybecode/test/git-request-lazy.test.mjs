import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { directToolExecutor, FatalToolExecutionError, ToolRegistry } from "@sortedyuan/core";
import { PermissionToolExecutor } from "@sortedyuan/permissions";
import { ProjectGitWorkspace } from "@sortedyuan/application/git-workspace";
import { createCodingTools } from "@sortedyuan/coding-tools";
import { GitRequestController } from "../dist/git-request.js";

const artifacts = fileURLToPath(new URL("../../../review/lazy-git-tests/", import.meta.url));
const execute = promisify(execFile);

async function fixture(t, managed = false, options = {}) {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "request-"));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = directory.replaceAll("\\", "/");
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  if (managed) {
    await git("init");
    await git("config", "user.name", "May integration test");
    await git("config", "user.email", "may-test@example.invalid");
  }
  const manager = await ProjectGitWorkspace.open({ workspace, deferInitialization: true,
    dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), ...options });
  const request = new GitRequestController(manager);
  t.after(async () => {
    await request.close();
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const tools = createCodingTools({ cwd: workspace });
  const execution = (name, input, signal = new AbortController().signal) => {
    const tool = tools.find(value => value.name === name);
    return { tool, input: tool.parse ? tool.parse(input) : input,
      context: { runId: "run", step: 1, toolCallId: name, idempotencyKey: name, signal, report() {} } };
  };
  const executor = new PermissionToolExecutor({ policy: () => "allow", executor: {
    async execute(value) { await request.beforeToolExecute(value); return directToolExecutor.execute(value); },
  } });
  t.after(() => executor.close());
  request.begin("session");
  return { directory, workspace, manager, request, git, execution, executor };
}

test("deferred discovery and read execution preserve an unmanaged directory", async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "source.txt"), "original\n");
  assert.equal((await f.manager.summary()).state, "unmanaged");
  await f.executor.execute(f.execution("read", { path: "source.txt" }));
  assert.equal(await f.request.lease(), undefined);
  assert.deepEqual(await readdir(f.workspace), ["source.txt"]);
  assert.equal(existsSync(join(f.directory, "records")), false);
});

test("permission denial never prepares Git or executes the write", async t => {
  const f = await fixture(t);
  const denied = new PermissionToolExecutor({ policy: () => "deny", executor: f.executor });
  t.after(() => denied.close());
  await assert.rejects(denied.execute(f.execution("write", { path: "denied.txt", content: "denied" })));
  assert.equal(await f.request.lease(), undefined);
  assert.deepEqual(await readdir(f.workspace), []);
  assert.equal(existsSync(join(f.directory, "records")), false);
});

test("the first approved modification initializes Git before allowing file execution", async t => {
  const f = await fixture(t, false, { authorizeCommit: () => false });
  assert.equal(existsSync(join(f.workspace, ".git")), false);
  await assert.rejects(f.executor.execute(f.execution("write", { path: "blocked.txt", content: "blocked" })), FatalToolExecutionError);
  assert.equal(existsSync(join(f.workspace, ".git")), true);
  assert.equal(existsSync(join(f.workspace, "blocked.txt")), false);
  assert.equal((await f.manager.summary()).state, "unborn");
});

test("lazy initialization saves original files and commits a complete modifying request", {
  skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async t => {
  let f;
  f = await fixture(t, false, { async authorizeCommit(request) {
    assert.equal(resolve(request.workspace), resolve(f.workspace));
    await f.git("config", "user.name", "May integration test");
    await f.git("config", "user.email", "may-test@example.invalid");
    return true;
  } });
  await writeFile(join(f.workspace, "source.txt"), "original\n");
  assert.equal(existsSync(join(f.workspace, ".git")), false);
  await f.executor.execute(f.execution("write", { path: "source.txt", content: "updated\n" }));
  const lease = await f.request.lease();
  assert.equal(await f.git("show", `${lease.fromCommit}:source.txt`), "original");
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
  const checkpoint = await lease.complete({ outcome: "completed", runId: "run" });
  assert.equal(checkpoint.status, "committed");
  assert.equal(await f.git("show", `${checkpoint.commit}:source.txt`), "updated");
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("Run snapshots retain trusted read metadata without exposing it to the model", async t => {
  const f = await fixture(t);
  const tool = f.execution("read", { path: "source.txt" }).tool;
  const registry = new ToolRegistry([tool]);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.require("read").workspaceEffect, "read");
  assert.equal("workspaceEffect" in snapshot.definitions()[0], false);
  tool.workspaceEffect = "write";
  assert.throws(() => registry.require("read"), /changed after it was registered/);
  assert.equal(snapshot.require("read").workspaceEffect, "read");
});

test("concurrent writes share one real workspace lease", async t => {
  const f = await fixture(t, true, { autoCommit: false });
  await Promise.all([
    f.executor.execute(f.execution("write", { path: "first.txt", content: "first" })),
    f.executor.execute(f.execution("write", { path: "second.txt", content: "second" })),
  ]);
  const lease = await f.request.lease();
  assert.ok(lease);
  assert.equal((await f.manager.checkpoints("session")).length, 1);
  await assert.rejects(f.manager.beginRound({ sessionId: "competitor" }), /already in use/);
  assert.equal((await lease.complete({ outcome: "completed", runId: "run" })).status, "uncommitted");
  await f.request.close();
  assert.equal(await readFile(join(f.workspace, "first.txt"), "utf8"), "first");
  assert.equal(await readFile(join(f.workspace, "second.txt"), "utf8"), "second");
  const next = await f.manager.beginRound({ sessionId: "next" });
  await next.close();
});

test("failed preparation stays failed for the whole request and preserves files", async t => {
  let approvals = 0;
  const f = await fixture(t, true, { authorizeCommit() { approvals++; return false; } });
  await writeFile(join(f.workspace, "source.txt"), "original");
  await Promise.all(["first", "second"].map(name => assert.rejects(
    f.executor.execute(f.execution("write", { path: "source.txt", content: name })), FatalToolExecutionError)));
  assert.equal(approvals, 1);
  assert.equal(await readFile(join(f.workspace, "source.txt"), "utf8"), "original");
  assert.equal(await f.git("diff", "--cached", "--name-only"), "");
  await f.request.close();
  f.request.begin("next");
  await assert.rejects(f.executor.execute(f.execution("write", { path: "source.txt", content: "next" })), FatalToolExecutionError);
  assert.equal(approvals, 2);
});

test("cancellation before the first write leaves Git uninitialized", async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.executor.execute(f.execution("write", { path: "cancelled.txt", content: "cancelled" }, abort.signal)));
  assert.equal(await f.request.lease(), undefined);
  assert.deepEqual(await readdir(f.workspace), []);
});

test("summary reads an unborn repository without creating checkpoints or state", async t => {
  const f = await fixture(t, true);
  assert.equal(await f.git("rev-parse", "--revs-only", "HEAD"), "");
  const state = await f.manager.summary();
  assert.equal(state.state, "unborn");
  assert.equal(state.commit, undefined);
  assert.equal(existsSync(join(f.directory, "records")), false);
  assert.deepEqual(await f.manager.checkpoints(), []);
});

test("a later request checks user edits even after the Session has an initial checkpoint", async t => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "baseline-"));
  const workspace = join(directory, "project");
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  await execute("git", ["clone", "--shared", source, workspace]);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("config", "user.name", "May integration test");
  await git("config", "user.email", "may-test@example.invalid");
  const approvals = [];
  const manager = await ProjectGitWorkspace.open({ workspace, deferInitialization: true,
    dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"),
    authorizeCommit(request) { approvals.push(request); return false; } });
  const original = (await manager.summary()).commit;
  const first = await manager.beginRound({ sessionId: "same-session" });
  await first.complete({ outcome: "completed", runId: "first" });
  await first.close();
  assert.equal(approvals.length, 0);
  await writeFile(join(workspace, "user-between-requests.txt"), "user changes\n");
  await assert.rejects(manager.beginRound({ sessionId: "same-session", runId: "second" }), /authorization was rejected/);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].initial, true);
  assert.ok(approvals[0].paths.includes("user-between-requests.txt"));
  assert.equal((await manager.summary()).commit, original);
  assert.equal(await readFile(join(workspace, "user-between-requests.txt"), "utf8"), "user changes\n");
  assert.equal(await git("diff", "--cached", "--name-only"), "");
});
