import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { simpleGit } from "simple-git";
import { GitWorkspaceConflictError, ProjectGitWorkspace } from "../dist/git-workspace.js";

test("read-only Git status remains available during a blocked real commit Hook", {
  skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1", timeout: 20_000,
}, async t => {
  const artifacts = resolve(fileURLToPath(new URL("../../../review/git-workspace-tests/", import.meta.url)));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "readers-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${artifacts}\\`) || resolve(root).startsWith(`${artifacts}/`)); await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, "project");
  await mkdir(workspace);
  const git = simpleGit({ baseDir: workspace });
  await git.init();
  assert.equal(await git.revparse(["--show-toplevel"]), workspace.replaceAll("\\", "/"));
  await git.addConfig("user.name", "May integration test");
  await git.addConfig("user.email", "may-test@example.invalid");
  await git.addConfig("core.autocrlf", "false");
  const files = await ProjectGitWorkspace.open({ workspace, dataRoot: join(root, "records"), worktreesRoot: join(root, "worktrees") });
  await writeFile(join(workspace, "source.txt"), "initial\n");
  const initial = await files.prepare("session");
  const round = await files.beginRound({ sessionId: "session" });
  await writeFile(join(workspace, "source.txt"), "next\n");
  const started = join(workspace, ".git", "may-hook-started");
  const release = join(workspace, ".git", "may-hook-release");
  await writeFile(join(workspace, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nprintf started > .git/may-hook-started\nwhile [ ! -f .git/may-hook-release ]; do sleep 0.1; done\n", { mode: 0o755 });
  let completed = false;
  const completion = round.complete({ outcome: "completed", runId: "run" }).then(value => { completed = true; return value; });
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { assert.equal(await readFile(started, "utf8"), "started"); break; }
      catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await delay(20);
    }
    let timer;
    const state = await Promise.race([files.status(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Git status waited for the blocked writer")), 5_000); })]).finally(() => clearTimeout(timer));
    assert.equal(state.commit, initial.commit);
    assert.equal(state.dirty, true);
    assert.equal(completed, false);
    await assert.rejects(files.beginRound({ sessionId: "competing" }), GitWorkspaceConflictError);
  } finally {
    await writeFile(release, "release\n");
    await completion;
  }
  assert.equal((await files.checkpointByRun("session", "run")).status, "committed");
});
