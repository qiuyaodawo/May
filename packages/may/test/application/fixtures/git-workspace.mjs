import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestDirectory } from "@sortedyuan/test-support";
import { simpleGit } from "simple-git";
import { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";

export const commitTests = { skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1" };

export async function fixture(t) {
  const root = await createTestDirectory(t, "may/git-workspace");
  const workspace = join(root, "project");
  await mkdir(workspace);
  const options = { workspace, dataRoot: join(root, "records"), worktreesRoot: join(root, "worktrees") };
  const git = simpleGit({ baseDir: workspace, maxConcurrentProcesses: 1 });
  return { root, workspace, options, git };
}

export async function managed(t) {
  const value = await fixture(t);
  await value.git.init();
  assert.equal(await value.git.revparse(["--show-toplevel"]), value.workspace.replaceAll("\\", "/"));
  const manager = await ProjectGitWorkspace.open(value.options);
  await value.git.addConfig("user.name", "May integration test");
  await value.git.addConfig("user.email", "may-test@example.invalid");
  await value.git.addConfig("core.autocrlf", "false");
  return { ...value, manager };
}
