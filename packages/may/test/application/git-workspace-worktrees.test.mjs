import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";
import { ProjectGitWorkspace, GitWorkspaceConflictError } from "@sortedyuan/may/application/git-workspace";
import { commitTests, managed } from "./fixtures/git-workspace.mjs";

test("subdirectory workspace creates exact historical worktree and protects lifecycle", commitTests, async (t) => {
  const { workspace, options, manager } = await managed(t);
  await mkdir(join(workspace, "app"));
  await writeFile(join(workspace, "app", "source.ts"), "before\n");
  const initial = await manager.prepare("source-session");
  await writeFile(join(workspace, "app", "source.ts"), "after\n");
  await (await manager.beginRound({ sessionId: "source-session" })).complete({ outcome: "completed" });
  const nested = await ProjectGitWorkspace.open({ ...options, workspace: join(workspace, "app") });
  assert.equal(nested.projectId, manager.projectId);
  const worktree = await nested.createWorktree({
    sessionId: "source-session",
    historyPosition: 5,
    checkpointId: initial.id,
  });
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

test("unmerged commits protect a worktree and real merge conflicts block automatic commits", commitTests, async (t) => {
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

test("failed Session attachment remains visible and its clean worktree can be deleted", commitTests, async (t) => {
  const { workspace, manager } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "version\n");
  const checkpoint = await manager.prepare("session");
  const worktree = await manager.createWorktree({
    sessionId: "session",
    historyPosition: 1,
    checkpointId: checkpoint.id,
  });
  await manager.failWorktree(worktree.id, new Error("Session state persistence failed"));
  assert.equal((await manager.listWorktrees())[0].status, "failed");
  await manager.deleteWorktree(worktree.id);
  assert.equal((await manager.listWorktrees()).length, 0);
});

test("sibling worktree management checks the registered source workspace history", commitTests, async (t) => {
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
  await assert.rejects(
    siblingManager.deleteWorktree(first.id),
    (error) => error instanceof GitWorkspaceConflictError && /commits not included/u.test(error.message),
  );
  await git.merge([first.branch]);
  await siblingManager.deleteWorktree(first.id);
  assert.equal((await manager.listWorktrees()).length, 1);
  assert.equal((await git.revparse([`refs/may/checkpoints/${completed.id}`])).trim(), completed.commit);
  await manager.deleteWorktree(sibling.id);
});
