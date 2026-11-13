import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { liveModelProfile } from "../fixtures/live-model.mjs";
import { artifacts, execute } from "../fixtures/goal-git.mjs";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import { MaybeCodeWorkspace } from "../../dist/workspace.js";

test(
  "real coding requests preserve Git checkpoints, current files and historical worktrees",
  {
    timeout: 180_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "request-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
    await git("init", "-b", "main");
    assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
    await git("config", "--local", "user.name", "May integration test");
    await git("config", "--local", "user.email", "may-test@example.invalid");
    await git("config", "--local", "core.autocrlf", "false");
    const skillDirectory = join(workspace, ".may", "skills", "git-fork-guide");
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: git-fork-guide\ndescription: Request guidance for the Git branch fixture.\n---\nRetain supplied file contents. Read references/location.txt only when the user asks for it.\n",
    );
    await writeFile(join(skillDirectory, "references", "location.txt"), "PROJECT_SKILL_RESOURCE\n");
    await writeFile(join(workspace, "value.txt"), "INITIAL_VALUE\n");
    const config = await loadMayConfig();
    const model = createBuiltinProviderModel(selectProviderModel(config, { model: liveModelProfile() }));
    const options = {
      workspace,
      model,
      store: new FileSessionStore(join(directory, "sessions")),
      catalog: new FileSessionCatalog(join(directory, "catalog.json")),
      goals: false,
      subagents: false,
      permissionPolicy: (check) => (["shell", "bash"].includes(check.tool.name) ? "deny" : "allow"),
      instructions:
        "Follow the requested file edits exactly. Use the provided coding tools. Do not run shell commands. Keep replies short.",
      git: {
        dataRoot: join(directory, "records"),
        worktreesRoot: join(directory, "worktrees"),
        authorizeCommit(request) {
          assert.ok(
            resolve(request.workspace) === resolve(workspace) ||
              resolve(request.workspace).startsWith(`${resolve(directory, "worktrees")}${sep}`),
          );
          return true;
        },
      },
    };
    let app = await MaybeCodeWorkspace.open(options);
    t.after(async () => {
      await app.close();
      const target = resolve(directory);
      assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
      await rm(target, { recursive: true, force: true });
    });
    assert.equal((await app.getWorkspaceGit()).branch, "main");
    assert.equal((await app.getWorkspaceGit()).commit, undefined);
    await app.activateSkill("git-fork-guide");
    const first = await app.submit({
      input:
        "Change value.txt to exactly FIRST_VERSION followed by a newline. Then create extra.txt containing exactly FIRST_EXTRA followed by a newline.",
    });
    await first.result;
    assert.equal(await git("rev-list", "--count", "HEAD"), "2");
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
    const firstPoint = (await app.getForkPoints()).find((point) => point.runId === first.id);
    assert.equal(firstPoint.available, true);
    assert.equal(firstPoint.worktreeAvailable, true);
    const records = await ProjectGitWorkspace.open({ ...options.git, workspace });
    assert.equal(
      (await records.checkpointByRun(app.sessionId, first.id)).historyPosition,
      Number(firstPoint.id.slice(app.sessionId.length + 1)),
    );
    const firstDiff = await app.getChanges({ scope: "run", runId: first.id });
    assert.deepEqual(new Set(firstDiff.files.map((file) => file.path)), new Set(["value.txt", "extra.txt"]));
    const second = await app.submit({
      input: "Change value.txt to exactly LATER_VERSION followed by a newline. Delete extra.txt.",
    });
    await second.result;
    assert.equal(await git("rev-list", "--count", "HEAD"), "3");
    const originalId = app.sessionId;
    const currentId = await app.forkSession(firstPoint.id, "current");
    assert.notEqual(currentId, originalId);
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
    assert.equal(app.workspace, workspace);
    assert.equal(
      (await app.history()).some(
        (event) =>
          event.type === "input.submitted" &&
          event.message.content.some((part) => part.text?.includes("LATER_VERSION")),
      ),
      false,
    );
    assert.match(app.application.instructions.effective, /Workspace files may have changed since that point/u);
    const inherited = (await app.getForkPoints(currentId)).find((point) => point.runId === first.id);
    assert.equal(inherited.commit, firstPoint.commit);
    assert.equal(inherited.worktreeAvailable, true);
    const worktreeId = await app.forkSession(inherited.id, "worktree");
    assert.notEqual(worktreeId, currentId);
    const worktreeWorkspace = app.workspace;
    assert.notEqual(worktreeWorkspace, workspace);
    assert.equal(await readFile(join(worktreeWorkspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
    assert.equal(await readFile(join(worktreeWorkspace, "extra.txt"), "utf8"), "FIRST_EXTRA\n");
    assert.equal((await app.getWorkspaceGit()).commit, firstPoint.commit);
    assert.equal(app.application.listSkills().find((skill) => skill.name === "git-fork-guide").active, true);
    assert.equal(
      (await app.readSkill("git-fork-guide")).directory,
      join(worktreeWorkspace, ".may", "skills", "git-fork-guide"),
    );
    const skillRequest = await app.submit({
      input:
        "Use skill_read to read git-fork-guide references/location.txt. Reply with the resource contents only. Do not modify files.",
    });
    assert.match(
      (await skillRequest.result).message.content.map((part) => part.text ?? "").join(""),
      /PROJECT_SKILL_RESOURCE/u,
    );
    const skillRead = [...(await app.history())]
      .reverse()
      .find((event) => event.type === "tool.completed" && event.call.name === "skill_read");
    assert.ok(skillRead !== undefined);
    await app.close();
    app = await MaybeCodeWorkspace.open({ ...options, sessionId: worktreeId });
    assert.equal(app.workspace, worktreeWorkspace);
    assert.equal((await app.getWorkspaceGit()).branch.startsWith("may/session-"), true);
    assert.equal(
      (await app.getForkPoints()).some((point) => point.sessionId === originalId),
      true,
    );
    await app.resumeSession(originalId);
    assert.equal(app.workspace, workspace);
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
    await app.resumeSession(currentId);
    assert.match(app.application.instructions.effective, /Workspace files may have changed since that point/u);
  },
);

test(
  "real historical forks restore the selected model profile, effort and continuation messages",
  {
    timeout: 180_000,
  },
  async (t) => {
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "model-profile-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    let config = await loadMayConfig();
    const profiles = [liveModelProfile(), "live-fork-profile"];
    config = {
      ...config,
      models: {
        ...config.models,
        [profiles[1]]: {
          ...config.models[profiles[0]],
          options: { ...config.models[profiles[0]].options, reasoningEffort: "high" },
        },
      },
    };
    const configuration = (profile, runtimeOptions = {}) => {
      const selected = selectProviderModel(config, { model: profile });
      return {
        model: createBuiltinProviderModel({ ...selected, options: { ...selected.options, ...runtimeOptions } }),
        modelInfo: { profile, provider: selected.provider, model: selected.model, adapter: selected.adapter },
      };
    };
    const catalogPath = join(directory, "catalog.json");
    const catalogOperations = `${catalogPath}.operations`;
    let breakCatalog = false;
    const app = await MaybeCodeWorkspace.open({
      workspace,
      git: false,
      ...configuration(profiles[0]),
      store: new FileSessionStore(join(directory, "sessions")),
      catalog: new FileSessionCatalog(catalogPath),
      configureWorkspace: async () => {
        if (breakCatalog) {
          breakCatalog = false;
          await rename(catalogOperations, `${catalogOperations}.saved`);
          await writeFile(catalogOperations, "catalog storage is unavailable");
        }
        return {};
      },
      createModelConfiguration: configuration,
      modelProfiles: profiles.map((name) => ({
        name,
        isDefault: name === profiles[0],
        ...configuration(name).modelInfo,
        ...(name === profiles[1] ? { reasoningEffort: "high" } : {}),
      })),
      goals: false,
      subagents: false,
      skills: false,
      tools: [],
      permissionPolicy: () => "deny",
    });
    t.after(async () => {
      await app.close();
      const target = resolve(directory);
      assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
      await rm(target, { recursive: true, force: true });
    });
    const first = await app.submit({ input: "Remember EARLY_PROFILE_MARKER. Reply exactly EARLY_PROFILE_MARKER." });
    await first.result;
    await app.switchModel(profiles[1]);
    const second = await app.submit({ input: "Remember LATER_PROFILE_MARKER. Reply exactly LATER_PROFILE_MARKER." });
    const secondResult = await second.result;
    const originalId = app.sessionId;
    const points = await app.getForkPoints(originalId);
    const firstPoint = points.find((point) => point.runId === first.id);
    const secondPoint = points.find((point) => point.runId === second.id);
    await app.switchModel(profiles[0]);
    breakCatalog = true;
    await assert.rejects(app.forkSession(secondPoint.id, "current"), /could not be recorded in the catalog/u);
    assert.equal(app.sessionId, originalId);
    assert.equal(app.application.modelInfo.profile, profiles[0]);
    assert.ok(resolve(catalogOperations).startsWith(`${resolve(directory)}${sep}`));
    await rm(catalogOperations);
    await rename(`${catalogOperations}.saved`, catalogOperations);
    await app.newSession();
    assert.equal(
      app.application.modelInfo.profile,
      profiles[0],
      "Failed fork creation must retain the current model configuration",
    );
    await app.resumeSession(originalId);
    const lateFork = await app.forkSession(secondPoint.id, "current");
    assert.equal(app.application.modelInfo.profile, profiles[1]);
    const copied = [...(await app.history())]
      .reverse()
      .find((event) => event.type === "assistant.completed" && event.runId === second.id);
    assert.deepEqual(copied.message, secondResult.message);
    const savedModel = [...(await app.history())]
      .reverse()
      .find((event) => event.type === "state.updated" && event.key === "maybecode.model");
    assert.equal(savedModel.value.runtimeOptions.reasoningEffort, "high");
    const recalled = await app.submit({
      input: "Which marker did I most recently ask you to remember? Reply with only that marker.",
    });
    assert.match(JSON.stringify((await recalled.result).message), /LATER_PROFILE_MARKER/u);
    await app.resumeSession(originalId);
    const earlyFork = await app.forkSession(firstPoint.id, "current");
    assert.notEqual(earlyFork, lateFork);
    assert.equal(app.application.modelInfo.profile, profiles[0]);
    assert.equal(
      (await app.history()).some((event) => event.type === "assistant.completed" && event.runId === second.id),
      false,
    );
    config = {
      ...config,
      models: {
        ...config.models,
        [profiles[1]]: {
          ...config.models[profiles[1]],
          model: `${config.models[profiles[1]].model}-changed-after-fork-point`,
        },
      },
    };
    await assert.rejects(app.forkSession(secondPoint.id, "current"), /original provider, model and adapter/u);
    assert.equal(app.sessionId, earlyFork);
  },
);
