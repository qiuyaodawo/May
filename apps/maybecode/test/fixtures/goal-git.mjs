import assert from "node:assert/strict";
import { testOutputRoot } from "@sortedyuan/test-support";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { liveModelProfile } from "./live-model.mjs";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";

export const execute = promisify(execFile);
export const artifacts = join(testOutputRoot, "maybecode", "session-fork-checkpoint");

export async function waitForGoal(app) {
  const deadline = Date.now() + 120_000;
  while (app.isRunning && Date.now() < deadline) await delay(10);
  assert.equal(app.isRunning, false, "Goal did not finish within its test deadline");
}

export async function goalGitFixture(prefix) {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, prefix));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "main");
  assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
  await git("config", "--local", "user.name", "May integration test");
  await git("config", "--local", "user.email", "may-test@example.invalid");
  await git("config", "--local", "core.autocrlf", "false");
  await writeFile(join(workspace, "README.md"), "# Goal checkpoint fixture\n");
  const gitOptions = {
    dataRoot: join(directory, "records"),
    authorizeCommit(request) {
      assert.equal(resolve(request.workspace), resolve(workspace));
      return true;
    },
  };
  return {
    workspace,
    git,
    statePath: join(directory, "external-goal.json"),
    gitWorkspace: await ProjectGitWorkspace.open({ ...gitOptions, workspace }),
    options: {
      workspace,
      model: createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: liveModelProfile() })),
      store: new FileSessionStore(join(directory, "sessions")),
      catalog: new FileSessionCatalog(join(directory, "catalog.json")),
      git: gitOptions,
      subagents: false,
      skills: false,
      permissionPolicy: (check) => (["shell", "bash"].includes(check.tool.name) ? "deny" : "allow"),
      instructions:
        "Follow explicit file contents and Goal instructions. Use write for file creation. Do not use shell. Keep replies short.",
    },
    async cleanup() {
      const target = resolve(directory);
      assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
      await rm(target, { recursive: true, force: true });
    },
  };
}
