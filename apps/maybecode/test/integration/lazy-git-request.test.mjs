import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { ProjectGitWorkspace } from "@may/application/git-workspace";
import { MaybeCodeWorkspace } from "../../dist/index.js";

const artifacts = fileURLToPath(new URL("../../../../review/lazy-git-live/", import.meta.url));
const execute = promisify(execFile);
const live = { timeout: 240_000, skip: process.env.MAY_LIVE_GIT_REQUEST_TESTS !== "1" };

async function fixture(t, managed) {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "request-"));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = directory.replaceAll("\\", "/");
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  if (managed) await git("init");
  const options = { workspace,
    model: createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" })),
    store: new FileSessionStore(join(directory, "sessions")),
    catalog: new FileSessionCatalog(join(directory, "catalog.json")), skills: false,
    git: { autoCommit: !managed, dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"),
      authorizeCommit() { throw new Error("This test never authorizes a Git commit"); } },
    permissionPolicy: check => ["shell", "bash"].includes(check.tool.name) ? "deny" : "allow",
    instructions: "Follow the requested operations exactly with the supplied tools. Never use shell. Keep replies short.",
  };
  t.after(async () => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace, options, git };
}

test("real read-only and denied requests leave an unmanaged workspace uninitialized", live, async t => {
  const f = await fixture(t, false);
  await writeFile(join(f.workspace, "source.txt"), "LAZY_READ_CONFIRMED\n");
  let denyWrites = false;
  const app = await MaybeCodeWorkspace.open({ ...f.options, subagents: false, goals: false,
    permissionPolicy: check => check.tool.name === "read" || !denyWrites && check.tool.name !== "shell" ? "allow" : "deny" });
  try {
    assert.equal((await app.getWorkspaceGit()).commit, undefined);
    assert.equal(existsSync(join(f.workspace, ".git")), false);
    const run = await app.submit({ input: "Read source.txt using read and reply with its exact contents. Do not modify any file." });
    await run.result;
    assert.ok((await app.history()).some(event => event.type === "tool.completed" && event.call?.name === "read"));
    assert.equal(existsSync(join(f.workspace, ".git")), false);
    assert.equal(existsSync(join(f.directory, "records")), false);
    denyWrites = true;
    await (await app.submit({ input: "Use write to create denied.txt containing DENIED. If permission is denied, stop and report it without retrying." })).result;
    assert.equal(existsSync(join(f.workspace, "denied.txt")), false);
    assert.equal(existsSync(join(f.workspace, ".git")), false);
    assert.equal(existsSync(join(f.directory, "records")), false);
  } finally { await app.close(); }
  const resumed = await MaybeCodeWorkspace.open({ ...f.options, subagents: false, goals: false,
    sessionId: app.sessionId, autoResume: true });
  try {
    assert.equal(resumed.sessionId, app.sessionId);
    await resumed.getWorkspaceGit();
    assert.equal(existsSync(join(f.workspace, ".git")), false);
    assert.equal(existsSync(join(f.directory, "records")), false);
  } finally { await resumed.close(); }
});

test("filesystem-root startup and status polling preserve Git and checkpoint files", live, async t => {
  const f = await fixture(t, false);
  const workspace = parse(resolve(f.workspace)).root;
  const dataRoot = join(homedir(), ".may", `lazy-root-${parse(f.directory).base}`);
  if (parse(dataRoot).root.toLowerCase() === workspace.toLowerCase()) {
    t.skip("Root workspace metadata requires a separate filesystem");
    return;
  }
  const gitExists = existsSync(join(workspace, ".git"));
  const index = join(workspace, ".git", "index");
  const before = existsSync(index) ? await stat(index) : undefined;
  const started = performance.now();
  let app;
  try {
    app = await MaybeCodeWorkspace.open({ ...f.options, workspace, subagents: false, goals: false,
      git: { dataRoot, worktreesRoot: `${dataRoot}-worktrees`, authorizeCommit() { throw new Error("Root commits are forbidden in this test"); } } });
    await app.getWorkspaceGit();
    await app.getWorkspaceGit();
    assert.equal(app.workspace, workspace);
    assert.equal(existsSync(dataRoot), false);
    t.diagnostic(`Root startup and two status reads: ${Math.round(performance.now() - started)} ms`);
  } finally {
    await app?.close();
  }
  assert.equal(existsSync(join(workspace, ".git")), gitExists);
  const after = existsSync(index) ? await stat(index) : undefined;
  assert.equal(after?.mtimeMs, before?.mtimeMs);
  assert.equal(after?.size, before?.size);
});

test("real delegated and Goal writes use lazy request checkpoints with autoCommit disabled", live, async t => {
  const f = await fixture(t, true);
  const app = await MaybeCodeWorkspace.open(f.options);
  try {
    assert.equal(existsSync(join(f.directory, "records")), false);
    await (await app.submit({ input: "Delegate one task to worker using delegate_tasks. The worker must use write to create child.txt containing exactly CHILD followed by a newline. Wait for completion and report the result. Do not create the file yourself." })).result;
    assert.equal(await readFile(join(f.workspace, "child.txt"), "utf8"), "CHILD\n");
    assert.ok(app.listDelegationRequests().length > 0);
    const manager = await ProjectGitWorkspace.open({ ...f.options.git, workspace: f.workspace });
    assert.equal((await manager.checkpoints(app.sessionId)).filter(value => value.runId).length, 1);
    await app.startGoal("Use write to create goal.txt containing exactly GOAL followed by a newline, then report completion with update_goal. Do not use shell.");
    const deadline = Date.now() + 120_000;
    while (["active", "running"].includes(app.getGoal()?.status)) {
      if (Date.now() >= deadline) throw new Error("Goal did not finish before the test deadline");
      await delay(50);
    }
    assert.equal(app.getGoal().status, "completed");
    assert.equal(await readFile(join(f.workspace, "goal.txt"), "utf8"), "GOAL\n");
    assert.equal((await manager.status()).commit, undefined);
    const lease = await manager.beginRound({ sessionId: "after-goal" });
    await lease.close();
  } finally { await app.close(); }
});
