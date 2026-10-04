import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";
import { ProjectGitWorkspace, GitCheckpointError, GitWorkspaceConflictError } from "../dist/git-workspace.js";

const artifactRoot = resolve(fileURLToPath(new URL("../../../review/git-workspace-tests/", import.meta.url)));
const commitTests = { skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1" };

async function fixture(t) {
  await mkdir(artifactRoot, { recursive: true });
  const root = await mkdtemp(join(artifactRoot, "git-"));
  t.after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(`${artifactRoot}\\`) || target.startsWith(`${artifactRoot}/`));
    await rm(target, { recursive: true, force: true });
  });
  const workspace = join(root, "project");
  await mkdir(workspace);
  const options = { workspace, dataRoot: join(root, "records"), worktreesRoot: join(root, "worktrees") };
  const git = simpleGit({ baseDir: workspace, maxConcurrentProcesses: 1 });
  return { root, workspace, options, git };
}

async function managed(t) {
  const value = await fixture(t);
  await value.git.init();
  assert.equal(await value.git.revparse(["--show-toplevel"]), value.workspace.replaceAll("\\", "/"));
  const manager = await ProjectGitWorkspace.open(value.options);
  await value.git.addConfig("user.name", "May integration test");
  await value.git.addConfig("user.email", "may-test@example.invalid");
  await value.git.addConfig("core.autocrlf", "false");
  return { ...value, manager };
}

test("read-only and disabled Git management leave an unmanaged project unchanged", async t => {
  const { workspace, options } = await fixture(t);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = resolve(workspace, "..").replaceAll("\\", "/");
  t.after(() => { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; });
  const readonly = await ProjectGitWorkspace.open({ ...options, readOnly: true });
  assert.equal((await readonly.status()).state, "unmanaged");
  const disabled = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  assert.equal((await disabled.status()).state, "unmanaged");
  assert.deepEqual(await readdir(workspace), ["source.ts"]);
});

test("initialization reports an unborn branch without creating a commit", async t => {
  const { manager } = await managed(t);
  const status = await manager.status();
  assert.equal(status.state, "unborn");
  assert.equal(status.commit, undefined);
  assert.equal(status.detached, false);
});

test("automatic management initializes a genuinely unmanaged project", commitTests, async t => {
  const { workspace, options, git } = await fixture(t);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = resolve(workspace, "..").replaceAll("\\", "/");
  t.after(() => { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; });
  const manager = await ProjectGitWorkspace.open(options);
  assert.equal(await git.revparse(["--show-toplevel"]), workspace.replaceAll("\\", "/"));
  await git.addConfig("user.name", "May integration test");
  await git.addConfig("user.email", "may-test@example.invalid");
  await git.addConfig("core.autocrlf", "false");
  await writeFile(join(workspace, "source.ts"), "initial version\n");
  const initial = await manager.prepare("session");
  assert.equal(initial.status, "committed");
  assert.equal((await git.log()).total, 1);
});

test("rejected authorization preserves working files and index", async t => {
  const { workspace, options, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const manager = await ProjectGitWorkspace.open({ ...options, authorizeCommit: () => false });
  await assert.rejects(manager.prepare("session"), GitCheckpointError);
  assert.equal((await git.status()).staged.length, 0);
  assert.equal((await manager.status()).commit, undefined);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "export const value = 1;\n");
  assert.equal((await manager.checkpoints("session"))[0].status, "failed");
});

test("divergent staged and working versions fail without changing the index", async t => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "staged\n");
  await git.add("source.ts");
  await writeFile(join(workspace, "source.ts"), "working\n");
  await assert.rejects(manager.prepare("session"), /Staged and working content differ/);
  assert.equal(await git.show([":source.ts"]), "staged\n");
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "working\n");
});

test("workspace lease rejects simultaneous writers and releases after cancellation", async t => {
  const { options } = await managed(t);
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const first = await manager.beginRound({ sessionId: "first" });
  await assert.rejects(manager.beginRound({ sessionId: "second" }), /already in use/);
  const checkpoint = await first.complete({ outcome: "cancelled" });
  assert.equal(checkpoint.status, "uncommitted");
  const second = await manager.beginRound({ sessionId: "second" });
  await second.close();
});

test("real child-process leases block competing writers and recover after process exit", async t => {
  const { options } = await managed(t);
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const child = fork(fileURLToPath(new URL("./git-workspace-lock-child.mjs", import.meta.url)), [JSON.stringify({ ...options, autoCommit: false })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolveReady, reject) => {
    child.once("message", resolveReady);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Lease child exited before readiness: ${code}`)));
  });
  await assert.rejects(manager.beginRound({ sessionId: "competing" }), /already in use/);
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  child.kill("SIGKILL");
  await exited;
  const recovered = await manager.beginRound({ sessionId: "recovered" });
  await assert.rejects(manager.beginRound({ sessionId: "still-competing" }), /already in use/);
  await recovered.close();
});

test("initial and complete-round checkpoints preserve versions, exclusions and restart metadata", commitTests, async t => {
  const { options, workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  await writeFile(join(workspace, ".env"), "TOKEN=fixture-value\n");
  await writeFile(join(workspace, ".gitignore"), "ignored/\n");
  await mkdir(join(workspace, "ignored"));
  await writeFile(join(workspace, "ignored", "build.txt"), "generated\n");
  const initial = await manager.prepare("session");
  assert.equal(initial.status, "committed");
  assert.equal((await git.log()).total, 1);
  assert.deepEqual((await git.status()).not_added, [".env"]);
  const lease = await manager.beginRound({ sessionId: "session" });
  await writeFile(join(workspace, "source.ts"), "export const value = 2;\n");
  await writeFile(join(workspace, "新增 source.ts"), "export const next = true;\n");
  await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const checkpoint = await lease.complete({ outcome: "completed", runId: "final-run", runIds: ["earlier-run", "final-run"], historyPosition: 20 });
  assert.equal(checkpoint.status, "committed");
  assert.equal(checkpoint.fromCommit, initial.commit);
  assert.equal((await git.log()).total, 2);
  const diff = await manager.diff({ from: initial.commit, to: checkpoint.commit });
  assert.equal(diff.files.length, 3);
  assert.equal(diff.files.find(file => file.path === "binary.bin").binary, true);
  assert.ok(diff.patch.includes("export const value = 2"));
  const resumed = await ProjectGitWorkspace.open(options);
  assert.equal((await resumed.checkpointByRun("session", "earlier-run")).id, checkpoint.id);
  const unchanged = await (await resumed.beginRound({ sessionId: "session", runId: "unchanged" })).complete({ outcome: "completed" });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.commit, checkpoint.commit);
  assert.equal((await git.log()).total, 2);
  assert.equal((await git.revparse([`refs/may/checkpoints/${checkpoint.id}`])).trim(), checkpoint.commit);
  await rm(join(workspace, "新增 source.ts"));
  const deletion = await (await resumed.beginRound({ sessionId: "session", runId: "delete" })).complete({ outcome: "completed" });
  const deletionDiff = await resumed.diff({ from: checkpoint.commit, to: deletion.commit });
  assert.equal(deletionDiff.deletions, 1);
});

test("subdirectory workspace creates exact historical worktree and protects lifecycle", commitTests, async t => {
  const { workspace, options, manager } = await managed(t);
  await mkdir(join(workspace, "app"));
  await writeFile(join(workspace, "app", "source.ts"), "before\n");
  const initial = await manager.prepare("source-session");
  await writeFile(join(workspace, "app", "source.ts"), "after\n");
  await (await manager.beginRound({ sessionId: "source-session" })).complete({ outcome: "completed" });
  const nested = await ProjectGitWorkspace.open({ ...options, workspace: join(workspace, "app") });
  assert.equal(nested.projectId, manager.projectId);
  const worktree = await nested.createWorktree({ sessionId: "source-session", historyPosition: 5, checkpointId: initial.id });
  assert.equal(await readFile(join(worktree.workspace, "source.ts"), "utf8"), "before\n");
  assert.equal(await readFile(join(workspace, "app", "source.ts"), "utf8"), "after\n");
  await nested.attachWorktreeSession(worktree.id, "fork-session");
  await assert.rejects(nested.deleteWorktree(worktree.id), /associated sessions/);
  await nested.attachWorktreeSession(worktree.id, "fork-session", false);
  await nested.trackWorktreeProcess(worktree.id, process.pid);
  await assert.rejects(nested.deleteWorktree(worktree.id), /running processes/);
  await nested.trackWorktreeProcess(worktree.id, process.pid, false);
  await writeFile(join(worktree.path, "untracked.txt"), "keep\n");
  await assert.rejects(nested.deleteWorktree(worktree.id), /file changes/);
  await rm(join(worktree.path, "untracked.txt"));
  await nested.deleteWorktree(worktree.id);
  assert.equal((await nested.listWorktrees()).length, 0);
  assert.equal((await nested.checkpoint(initial.id)).commit, initial.commit);
});

test("restore validates the reviewed content and changes regular files without Git file restoration", commitTests, async t => {
  const { workspace, manager } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "before\n");
  const initial = await manager.prepare("session");
  await writeFile(join(workspace, "source.ts"), "after\n");
  await writeFile(join(workspace, "new.ts"), "new\n");
  const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts", "new.ts"] });
  await writeFile(join(workspace, "source.ts"), "manual change\n");
  await assert.rejects(manager.restore(preview), error => error instanceof GitWorkspaceConflictError && /changed after restoration preview/u.test(error.message));
  assert.equal(await readFile(join(workspace, "new.ts"), "utf8"), "new\n");
  const updated = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts", "new.ts"] });
  assert.deepEqual(await manager.restore(updated), ["source.ts", "new.ts"]);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "before\n");
  await assert.rejects(readFile(join(workspace, "new.ts")), { code: "ENOENT" });
});

test("commit followed by metadata failure is recovered without a duplicate commit", commitTests, async t => {
  const { options, workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "persisted version\n");
  const records = join(options.dataRoot, manager.projectId, "checkpoints");
  await writeFile(records, "blocked metadata directory");
  await assert.rejects(manager.prepare("session"));
  assert.equal((await git.log()).total, 1);
  await rm(records);
  const reopened = await ProjectGitWorkspace.open(options);
  await reopened.prepare("session");
  assert.equal((await git.log()).total, 1);
  const checkpoints = await reopened.checkpoints("session");
  assert.equal(checkpoints.filter(checkpoint => checkpoint.recovered === true).length, 1);
});

test("renamed and untracked text and binary files have structured diff entries", commitTests, async t => {
  const { workspace, manager } = await managed(t);
  await writeFile(join(workspace, "original source.ts"), "export const value = 1;\n");
  const initial = await manager.prepare("session");
  await rename(join(workspace, "original source.ts"), join(workspace, "renamed source.ts"));
  const renamed = await (await manager.beginRound({ sessionId: "session", runId: "rename" })).complete({ outcome: "completed" });
  const versionDiff = await manager.diff({ from: initial.commit, to: renamed.commit });
  assert.equal(versionDiff.files[0].status, "renamed");
  assert.equal(versionDiff.files[0].previousPath, "original source.ts");
  assert.equal(versionDiff.files[0].path, "renamed source.ts");
  await writeFile(join(workspace, "new.ts"), "export const next = 2;\n");
  await writeFile(join(workspace, "new.bin"), Buffer.from([0, 2]));
  const workingDiff = await manager.diff({ from: renamed.commit });
  assert.equal(workingDiff.files.find(file => file.path === "new.ts").status, "untracked");
  assert.ok(workingDiff.files.find(file => file.path === "new.ts").patch.includes("export const next = 2"));
  assert.equal(workingDiff.files.find(file => file.path === "new.bin").binary, true);
});

test("failed and cancelled rounds and disabled autoCommit preserve uncommitted edits", commitTests, async t => {
  const { workspace, options, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "initial\n");
  const initial = await manager.prepare("session");
  const failed = await manager.beginRound({ sessionId: "session", runId: "failed" });
  await writeFile(join(workspace, "source.ts"), "failed changes\n");
  assert.equal((await failed.complete({ outcome: "failed" })).status, "uncommitted");
  const cancelled = await manager.beginRound({ sessionId: "session", runId: "cancelled" });
  assert.equal((await cancelled.complete({ outcome: "cancelled" })).commit, initial.commit);
  const disabled = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  assert.equal((await disabled.prepare("disabled-session")).status, "uncommitted");
  assert.equal((await git.log()).total, 1);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "failed changes\n");
});

test("file restoration can save its resulting checkpoint under the same lease", commitTests, async t => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "initial\n");
  const initial = await manager.prepare("session");
  const round = await manager.beginRound({ sessionId: "session", runId: "changes" });
  await writeFile(join(workspace, "source.ts"), "next\n");
  await round.complete({ outcome: "completed" });
  const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts"] });
  const checkpoint = await manager.restore(preview, { sessionId: "session", runId: "restore" });
  assert.equal(checkpoint.status, "committed");
  assert.equal((await git.log()).total, 3);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "initial\n");
});

test("unmerged commits protect a worktree and real merge conflicts block automatic commits", commitTests, async t => {
  const { workspace, options, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "base\n");
  const initial = await manager.prepare("source");
  const worktree = await manager.createWorktree({ sessionId: "source", historyPosition: 1, checkpointId: initial.id });
  const forked = await ProjectGitWorkspace.open({ ...options, workspace: worktree.workspace });
  await forked.prepare("fork");
  const forkRound = await forked.beginRound({ sessionId: "fork", runId: "fork-run" });
  await writeFile(join(worktree.workspace, "source.ts"), "fork version\n");
  await forkRound.complete({ outcome: "completed" });
  await assert.rejects(manager.deleteWorktree(worktree.id), /commits not included/);
  const sourceRound = await manager.beginRound({ sessionId: "source", runId: "source-run" });
  await writeFile(join(workspace, "source.ts"), "source version\n");
  await sourceRound.complete({ outcome: "completed" });
  await assert.rejects(git.merge([worktree.branch]));
  const before = await git.log();
  await assert.rejects(manager.prepare("source"), /unresolved conflicts/);
  assert.equal((await git.log()).total, before.total);
  assert.ok((await git.status()).conflicted.includes("source.ts"));
});

test("pre-commit Hook failure preserves staged files and can be corrected without duplicate commits", commitTests, async t => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "version\n");
  const hook = join(workspace, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(manager.prepare("session"), GitCheckpointError);
  assert.equal((await manager.status()).commit, undefined);
  assert.ok((await git.status()).staged.includes("source.ts"));
  await rm(hook);
  const resumed = await manager.beginRound({ sessionId: "session", runId: "run" });
  assert.equal(resumed.fromCommit, (await manager.status()).commit);
  assert.equal((await resumed.complete({ outcome: "completed" })).status, "unchanged");
  assert.equal((await git.log()).total, 1);
});

test("a failed dirty baseline is saved before the repaired Session starts another round", commitTests, async t => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "repository version\n");
  await manager.prepare("seed");
  await writeFile(join(workspace, "source.ts"), "initial manual version\n");
  const hook = join(workspace, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(manager.prepare("session"), GitCheckpointError);
  assert.equal((await manager.checkpoints("session"))[0].status, "failed");
  await rm(hook);
  const resumed = await manager.beginRound({ sessionId: "session", runId: "run" });
  assert.equal((await git.log()).total, 2);
  assert.equal(await git.show([`${resumed.fromCommit}:source.ts`]), "initial manual version\n");
  await writeFile(join(workspace, "source.ts"), "agent version\n");
  const checkpoint = await resumed.complete({ outcome: "completed" });
  assert.equal(checkpoint.fromCommit, resumed.fromCommit);
  assert.equal((await git.log()).total, 3);
  const diff = await manager.diff({ from: checkpoint.fromCommit, to: checkpoint.commit });
  assert.ok(diff.patch.includes("-initial manual version"));
  assert.ok(diff.patch.includes("+agent version"));
});

test("repository identity drift reports an error before following an ancestor", async t => {
  const { workspace, manager } = await managed(t);
  await rename(join(workspace, ".git"), join(workspace, ".git-hidden"));
  await assert.rejects(manager.status(), /repository identity changed/);
  await assert.rejects(manager.beginRound({ sessionId: "session" }), /repository identity changed/);
});

test("failed Session attachment remains visible and its clean worktree can be deleted", commitTests, async t => {
  const { workspace, manager } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "version\n");
  const checkpoint = await manager.prepare("session");
  const worktree = await manager.createWorktree({ sessionId: "session", historyPosition: 1, checkpointId: checkpoint.id });
  await manager.failWorktree(worktree.id, new Error("Session state persistence failed"));
  assert.equal((await manager.listWorktrees())[0].status, "failed");
  await manager.deleteWorktree(worktree.id);
  assert.equal((await manager.listWorktrees()).length, 0);
});

test("sibling worktree management checks the registered source workspace history", commitTests, async t => {
  const { workspace, options, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.txt"), "initial\n");
  const initial = await manager.prepare("source");
  const first = await manager.createWorktree({ sessionId: "source", historyPosition: 1, checkpointId: initial.id });
  const sibling = await manager.createWorktree({ sessionId: "source", historyPosition: 1, checkpointId: initial.id });
  const firstManager = await ProjectGitWorkspace.open({ ...options, workspace: first.workspace });
  const siblingManager = await ProjectGitWorkspace.open({ ...options, workspace: sibling.workspace });
  const round = await firstManager.beginRound({ sessionId: "first" });
  await writeFile(join(first.workspace, "source.txt"), "first worktree commit\n");
  const completed = await round.complete({ outcome: "completed" });
  await simpleGit({ baseDir: sibling.workspace }).merge([first.branch]);
  await assert.rejects(siblingManager.deleteWorktree(first.id), error => error instanceof GitWorkspaceConflictError && /commits not included/u.test(error.message));
  await git.merge([first.branch]);
  await siblingManager.deleteWorktree(first.id);
  assert.equal((await manager.listWorktrees()).length, 1);
  assert.equal((await git.revparse([`refs/may/checkpoints/${completed.id}`])).trim(), completed.commit);
  await manager.deleteWorktree(sibling.id);
});

test("file restoration recovers an applied pending checkpoint before recording its own commit", commitTests, async t => {
  const { workspace, options, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.txt"), "initial\n");
  const initial = await manager.prepare("session");
  const round = await manager.beginRound({ sessionId: "session", runId: "pending" });
  await writeFile(join(workspace, "source.txt"), "applied pending version\n");
  const records = join(options.dataRoot, manager.projectId, "checkpoints");
  const savedRecords = `${records}-saved`;
  await rename(records, savedRecords);
  await writeFile(records, "blocked metadata directory");
  await assert.rejects(round.complete({ outcome: "completed" }), GitCheckpointError);
  assert.equal((await git.log()).total, 2);
  await rm(records);
  await rename(savedRecords, records);
  const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.txt"] });
  assert.equal((await manager.restore(preview, { sessionId: "session", runId: "restore" })).status, "committed");
  const recovered = await manager.checkpointByRun("session", "pending");
  assert.equal(recovered.status, "committed");
  assert.equal(recovered.recovered, true);
  assert.equal((await git.log()).total, 3);
});
