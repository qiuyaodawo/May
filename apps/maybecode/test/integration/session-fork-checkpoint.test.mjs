import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { defaultSubagentConfiguration } from "@may/plugin-delegation";
import { createGoalsPlugin } from "@may/plugin-goals";
import { ProjectGitWorkspace } from "@may/application/git-workspace";
import { GoalController } from "@may/goal";
import { InMemoryContextFactory } from "@may/context";
import { runtimeHooks } from "@may/core";
import { MaybeCodeApplication, MaybeCodeWorkspace } from "../../dist/index.js";
import { startGitGoalRequest } from "../../dist/git-request.js";

const execute = promisify(execFile);
const artifacts = fileURLToPath(new URL("../../../../review/maybecode-fork-verification/", import.meta.url));

test("real coding requests preserve Git checkpoints, current files and historical worktrees", {
  timeout: 180_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
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
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: git-fork-guide\ndescription: Request guidance for the Git branch fixture.\n---\nRetain supplied file contents. Read references/location.txt only when the user asks for it.\n");
  await writeFile(join(skillDirectory, "references", "location.txt"), "PROJECT_SKILL_RESOURCE\n");
  await writeFile(join(workspace, "value.txt"), "INITIAL_VALUE\n");
  const config = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
  const options = { workspace, model, store: new FileSessionStore(join(directory, "sessions")),
    catalog: new FileSessionCatalog(join(directory, "catalog.json")), goals: false, subagents: false,
    permissionPolicy: (check) => ["shell", "bash"].includes(check.tool.name) ? "deny" : "allow",
    instructions: "Follow the requested file edits exactly. Use the provided coding tools. Do not run shell commands. Keep replies short.",
    git: { dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), authorizeCommit(request) {
      assert.ok(resolve(request.workspace) === resolve(workspace) || resolve(request.workspace).startsWith(`${resolve(directory, "worktrees")}${sep}`));
      return true;
    } } };
  let app = await MaybeCodeWorkspace.open(options);
  t.after(async () => {
    await app.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  assert.equal((await app.getWorkspaceGit()).branch, "main");
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
  await app.activateSkill("git-fork-guide");
  const first = await app.submit({ input: "Change value.txt to exactly FIRST_VERSION followed by a newline. Then create extra.txt containing exactly FIRST_EXTRA followed by a newline." });
  await first.result;
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  const firstPoint = (await app.getForkPoints()).find((point) => point.runId === first.id);
  assert.equal(firstPoint.available, true);
  assert.equal(firstPoint.worktreeAvailable, true);
  const records = await ProjectGitWorkspace.open({ ...options.git, workspace });
  assert.equal((await records.checkpointByRun(app.sessionId, first.id)).historyPosition, Number(firstPoint.id.slice(app.sessionId.length + 1)));
  const firstDiff = await app.getChanges({ scope: "run", runId: first.id });
  assert.deepEqual(new Set(firstDiff.files.map((file) => file.path)), new Set(["value.txt", "extra.txt"]));
  const second = await app.submit({ input: "Change value.txt to exactly LATER_VERSION followed by a newline. Delete extra.txt." });
  await second.result;
  assert.equal(await git("rev-list", "--count", "HEAD"), "3");
  const originalId = app.sessionId;
  const currentId = await app.forkSession(firstPoint.id, "current");
  assert.notEqual(currentId, originalId);
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
  assert.equal(app.workspace, workspace);
  assert.equal((await app.history()).some((event) => event.type === "input.submitted" && event.message.content.some((part) => part.text?.includes("LATER_VERSION"))), false);
  assert.match(app.instructions.effective, /Files may have changed after the historical reply/u);
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
  assert.equal((await app.listSkills()).find((skill) => skill.name === "git-fork-guide").active, true);
  assert.equal((await app.readSkill("git-fork-guide")).directory, join(worktreeWorkspace, ".may", "skills", "git-fork-guide"));
  const skillRequest = await app.submit({ input: "Use skill_read to read git-fork-guide references/location.txt. Reply with the resource contents only. Do not modify files." });
  assert.match((await skillRequest.result).message.content.map((part) => part.text ?? "").join(""), /PROJECT_SKILL_RESOURCE/u);
  const skillRead = [...await app.history()].reverse().find((event) => event.type === "tool.completed" && event.call.name === "skill_read");
  assert.ok(skillRead !== undefined);
  await app.close();
  app = await MaybeCodeWorkspace.open({ ...options, sessionId: worktreeId });
  assert.equal(app.workspace, worktreeWorkspace);
  assert.equal((await app.getWorkspaceGit()).branch.startsWith("may/session-"), true);
  assert.equal((await app.getForkPoints()).some((point) => point.sessionId === originalId), true);
  await app.resumeSession(originalId);
  assert.equal(app.workspace, workspace);
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
  await app.resumeSession(currentId);
  assert.match(app.instructions.effective, /Files may have changed after the historical reply/u);
});

test("real completed Goal saves its final files and a recoverable yielded position", {
  timeout: 120_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("completed-goal-");
  const app = await MaybeCodeWorkspace.open(fixture.options);
  t.after(async () => { await app.close(); await fixture.cleanup(); });
  await app.startGoal("Use write to create goal.txt containing exactly COMPLETED_GOAL followed by a newline, then call update_goal with status completed and evidence that the requested file was written. Do not use shell.");
  await waitForGoal(app);
  assert.equal(app.getGoal().status, "completed", JSON.stringify(app.getGoal()));
  assert.equal(await readFile(join(fixture.workspace, "goal.txt"), "utf8"), "COMPLETED_GOAL\n");
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  const history = await app.history();
  const final = [...history].reverse().find(event => event.type === "run.yielded");
  assert.ok(final);
  assert.equal(history.some(event => event.type === "run.settled" && event.runId === final.runId && event.hostCompleted === true), true);
  const point = (await app.getForkPoints(app.sessionId)).find(point => point.runId === final.runId);
  assert.equal(point.available, true);
  assert.equal(point.worktreeAvailable, true);
  assert.equal((await fixture.gitWorkspace.checkpointByRun(app.sessionId, final.runId)).historyPosition, Number(point.id.slice(app.sessionId.length + 1)));
  const forkId = await app.forkSession(point.id, "current");
  assert.notEqual(forkId, final.sessionId);
  assert.equal(app.getGoal(), undefined);
  assert.equal((await app.getForkPoints(forkId)).find(item => item.runId === final.runId).available, true);
});

test("real Goal verification owns the Git lease and saves files after accepted verification", {
  timeout: 180_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("verified-goal-");
  let competitor;
  let checks = 0;
  const plugin = createGoalsPlugin({
    async verify() {
      checks++;
      assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
      await assert.rejects(competitor.submit({ input: "Reply with COMPETING_VERIFICATION." }), /Git workspace is already in use/u);
      const contents = await readFile(join(fixture.workspace, "goal.txt"), "utf8");
      return { completed: contents === "VERIFIED_GOAL\n", evidence: "goal.txt must contain exactly VERIFIED_GOAL followed by a newline. Use write to correct it and request completion again." };
    },
    createAgent: application => ({
      sessionId: application.sessionId,
      get isRunning() { return application.isRunning; },
      submit: options => startGitGoalRequest(fixture.gitWorkspace, application.sessionId, () => application.submit(options), () => {},
        runId => application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq),
      continue: options => startGitGoalRequest(fixture.gitWorkspace, application.sessionId, () => application.continue(options), () => {},
        runId => application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq),
    }),
  });
  const app = await MaybeCodeWorkspace.open({ ...fixture.options, plugins: [plugin] });
  competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
  t.after(async () => { await app.close(); await competitor.close(); await fixture.cleanup(); });
  await app.startGoal("Call get_goal at the beginning of every Run. When usage.runs is 1, use write to create goal.txt containing exactly NEEDS_VERIFICATION followed by a newline, then update_goal completed. During subsequent Runs, follow the verifier's correction in goal.progress and request completion again. Do not use shell.", { maxRuns: 3 });
  await waitForGoal(app);
  assert.equal(app.getGoal().status, "completed", JSON.stringify(app.getGoal()));
  assert.equal(app.getGoal().completion.source, "verifier");
  assert.equal(checks, 2);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  const yielded = (await app.history()).filter(event => event.type === "run.yielded");
  assert.equal(yielded.length, 2);
  const points = await app.getForkPoints(app.sessionId);
  assert.equal(points.find(point => point.runId === yielded[0].runId).available, false);
  assert.equal(points.find(point => point.runId === yielded[1].runId).available, true);
  assert.equal(points.find(point => point.runId === yielded[1].runId).worktreeAvailable, true);
  const next = await competitor.submit({ input: "Reply exactly VERIFIED_LEASE_RELEASED without tools." });
  assert.match(JSON.stringify((await next.result).message), /VERIFIED_LEASE_RELEASED/u);
});

async function waitForGoal(app) {
  const deadline = Date.now() + 120_000;
  while (app.isRunning && Date.now() < deadline) await delay(10);
  assert.equal(app.isRunning, false, "Goal did not finish within its test deadline");
}

test("public Goal adapter forwards continuation options and finalizes actual file checkpoints", {
  timeout: 120_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("public-goal-adapter-");
  const goals = new GoalController();
  const app = await MaybeCodeApplication.open({ ...fixture.options, goals: false,
    model: goals.wrapModel(fixture.options.model), contextFactory: goals.wrapContextFactory(new InMemoryContextFactory()),
    toolSource: () => goals.tools(), gitWorkspace: fixture.gitWorkspace,
  });
  t.after(async () => { await goals.close(); await app.close(); await fixture.cleanup(); });
  await goals.attach(app.goalAgent(), {
    async read() { return existsSync(fixture.statePath) ? JSON.parse(await readFile(fixture.statePath, "utf8")) : undefined; },
    async write(state) { await writeFile(fixture.statePath, JSON.stringify(state)); },
  });
  await goals.start("Call get_goal at the beginning of each Run. When usage.runs is 1, use write to create first.txt containing exactly FIRST_GOAL_RUN followed by a newline, then reply READY without update_goal. When usage.runs is 2, create second.txt containing exactly FINAL_GOAL_RUN followed by a newline, then update_goal completed. Do not use shell.", { maxRuns: 2 });
  await goals.wait();
  assert.equal(goals.getGoal().status, "completed", JSON.stringify(goals.getGoal()));
  assert.equal(goals.getGoal().usage.runs, 2);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "3");
  assert.equal(await readFile(join(fixture.workspace, "first.txt"), "utf8"), "FIRST_GOAL_RUN\n");
  assert.equal(await readFile(join(fixture.workspace, "second.txt"), "utf8"), "FINAL_GOAL_RUN\n");
  const history = await app.history();
  assert.equal(history.filter(event => event.type === "input.submitted").length, 1);
  const final = [...history].reverse().find(event => event.type === "run.yielded");
  assert.ok(final, "Goal continuation must retain its shouldYield option");
  const position = (await app.branchPositions()).find(position => position.runId === final.runId);
  assert.equal(position.available, true);
  assert.equal((await fixture.gitWorkspace.checkpointByRun(app.sessionId, final.runId)).historyPosition, position.positionSeq);
});

test("real verification failure and cancellation release the Goal lease with uncommitted files", {
  timeout: 180_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("failed-goal-");
  let verification = "missing-file";
  let resolveVerification;
  const verificationStarted = new Promise(resolve => { resolveVerification = resolve; });
  const plugin = createGoalsPlugin({
    async verify(_state, signal) {
      if (verification === "missing-file") {
        await readFile(join(fixture.workspace, "required-evidence.txt"), "utf8");
        return { completed: true, evidence: "Required evidence was read." };
      }
      assert.equal(await readFile(join(fixture.workspace, "cancelled.txt"), "utf8"), "CANCELLED_GOAL\n");
      signal.throwIfAborted();
      resolveVerification();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      signal.throwIfAborted();
      return { completed: true, evidence: "Cancellation verification finished." };
    },
    createAgent: application => ({
      sessionId: application.sessionId,
      get isRunning() { return application.isRunning; },
      submit: options => startGitGoalRequest(fixture.gitWorkspace, application.sessionId, () => application.submit(options), () => {},
        runId => application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq),
      continue: options => startGitGoalRequest(fixture.gitWorkspace, application.sessionId, () => application.continue(options), () => {},
        runId => application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq),
    }),
  });
  const app = await MaybeCodeWorkspace.open({ ...fixture.options, plugins: [plugin] });
  const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
  t.after(async () => { await app.close(); await competitor.close(); await fixture.cleanup(); });
  await app.startGoal("Use write to create retained.txt containing exactly RETAINED_GOAL followed by a newline, then update_goal completed. Do not create any other files. Do not use shell.");
  await waitForGoal(app);
  assert.equal(app.getGoal().status, "failed");
  assert.match(app.getGoal().reason, /ENOENT/u);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
  assert.match(await fixture.git("status", "--porcelain"), /retained\.txt/u);
  assert.equal((await app.getForkPoints(app.sessionId)).some(point => point.available), false);
  const afterFailure = await competitor.submit({ input: "Reply exactly FAILURE_LEASE_RELEASED without tools." });
  assert.match(JSON.stringify((await afterFailure.result).message), /FAILURE_LEASE_RELEASED/u);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  await app.cancelGoal();
  verification = "wait-for-cancellation";
  await app.startGoal("Use write to create cancelled.txt containing exactly CANCELLED_GOAL followed by a newline, then update_goal completed. Do not create any other files. Do not use shell.");
  await verificationStarted;
  await assert.rejects(competitor.submit({ input: "Reply exactly COMPETING_CANCELLED_VERIFICATION." }), /Git workspace is already in use/u);
  assert.equal((await app.pauseGoal()).status, "paused");
  assert.equal(app.isRunning, false);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  assert.match(await fixture.git("status", "--porcelain"), /cancelled\.txt/u);
  assert.equal((await app.getForkPoints(app.sessionId)).some(point => point.available), false);
  const afterCancellation = await competitor.submit({ input: "Reply exactly CANCELLATION_LEASE_RELEASED without tools." });
  assert.match(JSON.stringify((await afterCancellation.result).message), /CANCELLATION_LEASE_RELEASED/u);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "3");
});

async function goalGitFixture(prefix) {
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
  const gitOptions = { dataRoot: join(directory, "records"), authorizeCommit(request) {
    assert.equal(resolve(request.workspace), resolve(workspace)); return true;
  } };
  return {
    workspace, git,
    statePath: join(directory, "external-goal.json"),
    gitWorkspace: await ProjectGitWorkspace.open({ ...gitOptions, workspace }),
    options: { workspace,
      model: createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" })),
      store: new FileSessionStore(join(directory, "sessions")), catalog: new FileSessionCatalog(join(directory, "catalog.json")),
      git: gitOptions, subagents: false, skills: false,
      permissionPolicy: check => ["shell", "bash"].includes(check.tool.name) ? "deny" : "allow",
      instructions: "Follow explicit file contents and Goal instructions. Use write for file creation. Do not use shell. Keep replies short.",
    },
    async cleanup() {
      const target = resolve(directory); assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
      await rm(target, { recursive: true, force: true });
    },
  };
}

test("real historical forks restore the selected model profile, effort and continuation messages", {
  timeout: 180_000,
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "model-profile-"));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  let config = await loadMayConfig();
  const profiles = ["deepseek-v4-flash", "deepseek-fork-profile"];
  config = { ...config, models: { ...config.models, [profiles[1]]: {
    ...config.models[profiles[0]], options: { ...config.models[profiles[0]].options, reasoningEffort: "high" },
  } } };
  const configuration = (profile, runtimeOptions = {}) => {
    const selected = selectProviderModel(config, { model: profile });
    return { model: createBuiltinProviderModel({ ...selected, options: { ...selected.options, ...runtimeOptions } }),
      modelInfo: { profile, provider: selected.provider, model: selected.model, adapter: selected.adapter } };
  };
  const catalogPath = join(directory, "catalog.json");
  const catalogOperations = `${catalogPath}.operations`;
  let breakCatalog = false;
  const app = await MaybeCodeWorkspace.open({
    workspace, git: false, ...configuration(profiles[0]),
    store: new FileSessionStore(join(directory, "sessions")), catalog: new FileSessionCatalog(catalogPath),
    configureWorkspace: async () => {
      if (breakCatalog) {
        breakCatalog = false;
        await rename(catalogOperations, `${catalogOperations}.saved`);
        await writeFile(catalogOperations, "catalog storage is unavailable");
      }
      return {};
    },
    createModelConfiguration: configuration,
    modelProfiles: profiles.map(name => ({ name, isDefault: name === profiles[0], ...configuration(name).modelInfo,
      ...(name === profiles[1] ? { reasoningEffort: "high" } : {}) })),
    goals: false, subagents: false, skills: false, tools: [], permissionPolicy: () => "deny",
  });
  t.after(async () => {
    await app.close();
    const target = resolve(directory); assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  const first = await app.submit({ input: "Remember EARLY_PROFILE_MARKER. Reply exactly EARLY_PROFILE_MARKER." });
  await first.result;
  await app.switchModel(profiles[1]);
  const second = await app.submit({ input: "Remember LATER_PROFILE_MARKER. Reply exactly LATER_PROFILE_MARKER." });
  const secondResult = await second.result;
  const originalId = app.sessionId;
  const points = await app.getForkPoints(originalId);
  const firstPoint = points.find(point => point.runId === first.id);
  const secondPoint = points.find(point => point.runId === second.id);
  await app.switchModel(profiles[0]);
  breakCatalog = true;
  await assert.rejects(app.forkSession(secondPoint.id, "current"), /could not be recorded in the catalog/u);
  assert.equal(app.sessionId, originalId);
  assert.equal(app.modelInfo.profile, profiles[0]);
  assert.ok(resolve(catalogOperations).startsWith(`${resolve(directory)}${sep}`));
  await rm(catalogOperations);
  await rename(`${catalogOperations}.saved`, catalogOperations);
  await app.newSession();
  assert.equal(app.modelInfo.profile, profiles[0], "Failed fork creation must retain the current model configuration");
  await app.resumeSession(originalId);
  const lateFork = await app.forkSession(secondPoint.id, "current");
  assert.equal(app.modelInfo.profile, profiles[1]);
  const copied = [...await app.history()].reverse().find(event => event.type === "assistant.completed" && event.runId === second.id);
  assert.deepEqual(copied.message, secondResult.message);
  const savedModel = [...await app.history()].reverse().find(event => event.type === "state.updated" && event.key === "maybecode.model");
  assert.equal(savedModel.value.runtimeOptions.reasoningEffort, "high");
  const recalled = await app.submit({ input: "Which marker did I most recently ask you to remember? Reply with only that marker." });
  assert.match(JSON.stringify((await recalled.result).message), /LATER_PROFILE_MARKER/u);
  await app.resumeSession(originalId);
  const earlyFork = await app.forkSession(firstPoint.id, "current");
  assert.notEqual(earlyFork, lateFork);
  assert.equal(app.modelInfo.profile, profiles[0]);
  assert.equal((await app.history()).some(event => event.type === "assistant.completed" && event.runId === second.id), false);
  config = { ...config, models: { ...config.models, [profiles[1]]: config.models["gpt-5.6-luna"] } };
  await assert.rejects(app.forkSession(secondPoint.id, "current"), /original provider, model and adapter/u);
  assert.equal(app.sessionId, earlyFork);
});

test("real delegated requests keep the Git lease through child tasks and the final main Run", {
  timeout: 180_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "delegated-request-"));
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "main");
  assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
  await git("config", "--local", "user.name", "May integration test");
  await git("config", "--local", "user.email", "may-test@example.invalid");
  await git("config", "--local", "core.autocrlf", "false");
  await writeFile(join(workspace, "README.md"), "# Delegated checkpoint fixture\n");
  const model = createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" }));
  const base = defaultSubagentConfiguration();
  const options = {
    workspace, model, store: new FileSessionStore(join(directory, "sessions")),
    catalog: new FileSessionCatalog(join(directory, "catalog.json")), goals: false, skills: false,
    permissionPolicy: (check) => ["shell", "bash"].includes(check.tool.name) ? "deny" : "allow",
    instructions: "Delegate the explicitly requested independent file tasks through delegate_tasks. The main agent must wait for the child outcomes, then read their files and report completion. Keep final replies short. Do not run shell commands.",
    subagents: { dataDirectory: join(directory, "delegation"), configuration: {
      ...base, roles: [{ name: "worker", tools: ["read", "write", "edit"], delegateTo: [] }],
      limits: { ...base.limits, maxTasks: 3, maxConcurrent: 2, maxDepth: 2 },
    } },
    git: { dataRoot: join(directory, "records"), authorizeCommit(request) {
      assert.equal(resolve(request.workspace), resolve(workspace));
      return true;
    } },
  };
  const app = await MaybeCodeWorkspace.open(options);
  const competitor = await MaybeCodeWorkspace.open({ ...options, subagents: false });
  let resolveChildrenRunning;
  const childrenRunning = new Promise((resolve) => { resolveChildrenRunning = resolve; });
  let resolveFinalRun;
  const finalRun = new Promise((resolve) => { resolveFinalRun = resolve; });
  let mainRunCount = 0;
  const events = [];
  const observing = (async () => {
    for await (const event of app.events) {
      events.push(event);
      if (event.type === "delegation.updated" && event.state.tasks.some((task) => task.depth === 2 && task.status === "running")) {
        resolveChildrenRunning(event.state);
      }
      if (event.type === "run.event" && event.event.type === "run.started" && ++mainRunCount === 2) {
        resolveFinalRun(event.event);
      }
    }
  })();
  t.after(async () => {
    await app.close();
    await competitor.close();
    await observing;
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(artifacts)}${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
  const request = await app.submit({ input: "Call delegate_tasks exactly once with two independent worker tasks. Task child-a owns only child-a.txt and must create it with exactly CHILD_A followed by a newline. Task child-b owns only child-b.txt and must create it with exactly CHILD_B followed by a newline. Give each task a standalone brief and the exact files array. After both tasks finish, use read to inspect both files, then report their two markers. Do not create or edit these files yourself. Do not use shell." });
  await Promise.race([childrenRunning, request.result.then(() => { throw new Error("The request finished before a child task ran"); })]);
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
  await assert.rejects(competitor.submit({ input: "Reply exactly COMPETING_REQUEST." }), /Git workspace is already in use/u);
  await Promise.race([finalRun, request.result.then(() => { throw new Error("The request finished without a second main Run"); })]);
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
  await assert.rejects(competitor.submit({ input: "Reply exactly COMPETING_FINAL_RUN." }), /Git workspace is already in use/u);
  const result = await request.result;
  const runs = await request.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].result.finishReason, "yielded");
  assert.equal(result.runId, runs[1].runId);
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await readFile(join(workspace, "child-a.txt"), "utf8"), "CHILD_A\n");
  assert.equal(await readFile(join(workspace, "child-b.txt"), "utf8"), "CHILD_B\n");
  const state = app.getDelegationState();
  assert.equal(state.status, "completed");
  assert.equal(state.tasks.filter((task) => task.depth === 2 && task.status === "completed").length, 2);
  assert.deepEqual(state.mainRunIds, runs.map((run) => run.runId));
  const points = await app.getForkPoints(app.sessionId);
  assert.equal(points.find((point) => point.runId === runs[0].runId).available, false);
  assert.equal(points.find((point) => point.runId === runs[1].runId).available, true);
  assert.equal(points.find((point) => point.runId === runs[1].runId).worktreeAvailable, true);
  const changes = await app.getChanges({ scope: "run", runId: runs[1].runId });
  assert.deepEqual(new Set(changes.files.map((file) => file.path)), new Set(["child-a.txt", "child-b.txt"]));
  assert.equal(events.filter((event) => event.type === "workspace.git.changed" && event.checkpoint.status === "committed").length, 1);
  const next = await competitor.submit({ input: "Reply exactly LEASE_RELEASED without tools." });
  assert.match(JSON.stringify((await next.result).message), /LEASE_RELEASED/u);
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
});

for (const mode of ["request", "Goal"]) {
  for (const outcome of ["failure", "cancellation"]) {
    test(`real delegated ${mode} ${outcome} checkpoints retain every main Run identity`, {
      timeout: 120_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
    }, async (t) => {
      const fixture = await goalGitFixture(`delegated-${mode}-${outcome}-`);
      let reportRunStarted;
      const reportRun = new Promise(resolve => { reportRunStarted = resolve; });
      let observedMainRuns = 0;
      const requiredEvidence = { id: "verification.required-delegated-evidence", version: "1.0.0",
        setup(context) {
          context.on(runtimeHooks.runStarted, async (_value, hook) => {
            if (++observedMainRuns !== 2) return;
            assert.equal(await readFile(join(fixture.workspace, "child.txt"), "utf8"), "CHILD_EVIDENCE\n");
            reportRunStarted(hook.runId);
            if (outcome === "failure") {
              await readFile(join(fixture.workspace, "required-report-evidence.json"), "utf8");
              return;
            }
            await new Promise((resolve, reject) => {
              if (hook.signal.aborted) reject(hook.signal.reason);
              else hook.signal.addEventListener("abort", () => reject(hook.signal.reason), { once: true });
            });
          });
        },
      };
      const base = defaultSubagentConfiguration();
      const app = await MaybeCodeWorkspace.open({ ...fixture.options, goals: mode === "Goal" ? {} : false,
        plugins: [requiredEvidence],
        subagents: { dataDirectory: join(fixture.workspace, "..", "delegation"), configuration: {
          ...base, roles: [{ name: "worker", tools: ["read", "write", "edit"], delegateTo: [] }],
        } },
      });
      const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
      t.after(async () => { await app.close(); await competitor.close(); await fixture.cleanup(); });
      const input = "Call delegate_tasks exactly once with one independent worker task. The worker owns only child.txt and must use write to create it with exactly CHILD_EVIDENCE followed by a newline. Include its exact files array and a standalone brief. Wait for its result, then read child.txt and report completion. Do not write the file yourself. Do not use shell.";
      let request;
      let requestError;
      if (mode === "request") {
        request = await app.submit({ input });
        requestError = request.result.then(() => { throw new Error("The delegated request unexpectedly completed"); }, error => error);
        await Promise.race([reportRun, requestError.then(error => { throw error; })]);
      } else {
        await app.startGoal(input, { maxRuns: 2 });
        await Promise.race([reportRun, waitForGoal(app).then(() => { throw new Error(`The Goal finished before its report Run started: ${JSON.stringify(app.getGoal())}; observed main Runs: ${observedMainRuns}; delegation: ${JSON.stringify(app.getDelegationState())}`); })]);
      }
      const lastRunId = await reportRun;
      if (outcome === "cancellation") {
        await assert.rejects(competitor.submit({ input: "Reply COMPETING_CANCELLED_REPORT." }), /Git workspace is already in use/u);
        if (mode === "request") request.cancel("Cancel the delegated report Run");
        else assert.equal((await app.cancelGoal()).status, "cancelled");
      }
      if (mode === "request") {
        const error = await requestError;
        assert.match(String(error), outcome === "failure" ? /ENOENT/u : /Cancel|cancel/u);
      } else {
        await waitForGoal(app);
        assert.equal(app.getGoal().status, outcome === "failure" ? "failed" : "cancelled", JSON.stringify(app.getGoal()));
      }
      const runIds = (await app.history()).filter(event => event.type === "run.started").map(event => event.runId);
      assert.equal(runIds.length, 2);
      assert.equal(lastRunId, runIds[1]);
      const checkpoint = await fixture.gitWorkspace.checkpointByRun(app.sessionId, lastRunId);
      assert.ok(checkpoint, "The last main Run must have its request checkpoint");
      assert.equal(checkpoint.runId, lastRunId);
      assert.deepEqual(checkpoint.runIds, runIds);
      assert.equal(checkpoint.status, "uncommitted");
      assert.equal((await fixture.gitWorkspace.checkpointByRun(app.sessionId, runIds[0])).id, checkpoint.id);
      assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
      const changes = await app.getChanges({ scope: "run", runId: lastRunId });
      assert.deepEqual(changes.files.map(file => file.path), ["child.txt"]);
      assert.equal((await app.getForkPoints(app.sessionId)).some(point => point.available), false);
      const released = await competitor.submit({ input: "Reply exactly REPORT_LEASE_RELEASED without tools." });
      assert.match(JSON.stringify((await released.result).message), /REPORT_LEASE_RELEASED/u);
      assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
    });
  }
}

test("real delegated Goal meters a role model and saves one completed request checkpoint", {
  timeout: 120_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("delegated-role-goal-");
  const config = await loadMayConfig();
  let roleModels = 0;
  const base = defaultSubagentConfiguration();
  const app = await MaybeCodeWorkspace.open({ ...fixture.options,
    subagents: { dataDirectory: join(fixture.workspace, "..", "delegation"),
      createRoleModel(role) {
        assert.equal(role.model, "deepseek-v4-flash");
        roleModels++;
        return createBuiltinProviderModel(selectProviderModel(config, { model: role.model }));
      },
      configuration: { ...base, roles: [{ name: "worker", model: "deepseek-v4-flash", tools: ["read", "write", "edit"], delegateTo: [] }] },
    },
  });
  t.after(async () => { await app.close(); await fixture.cleanup(); });
  await app.startGoal("Call delegate_tasks exactly once with one independent worker task. The worker owns only role-child.txt and must use write to create it with exactly ROLE_CHILD_GOAL followed by a newline. Include its exact files array and a standalone brief. After the child finishes, read role-child.txt and then call update_goal completed with the file contents as evidence. Do not write the file yourself. Do not use shell.", { maxRuns: 2 });
  await waitForGoal(app);
  const goal = app.getGoal();
  assert.equal(goal.status, "completed", JSON.stringify(goal));
  assert.ok(roleModels > 0);
  assert.equal(goal.usage.usageComplete, true);
  const child = app.getDelegationState().tasks.find(task => task.depth === 2);
  assert.equal(child.status, "completed");
  const childRunIds = (await fixture.options.store.inspect(child.sessionId)).filter(event => event.type === "run.started").map(event => event.runId);
  assert.ok(childRunIds.length > 0);
  const childCalls = goal.calls.filter(call => childRunIds.includes(call.runId));
  assert.ok(childCalls.length > 0, "The role-specific child's actual model calls must be metered by the Goal");
  assert.ok(childCalls.every(call => call.status === "settled" && call.tokens > 0));
  assert.equal(goal.usage.totalTokens, goal.calls.reduce((total, call) => total + call.tokens, 0));
  assert.equal(await readFile(join(fixture.workspace, "role-child.txt"), "utf8"), "ROLE_CHILD_GOAL\n");
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  const runIds = (await app.history()).filter(event => event.type === "run.started").map(event => event.runId);
  assert.equal(runIds.length, 2);
  const checkpoint = await fixture.gitWorkspace.checkpointByRun(app.sessionId, runIds[1]);
  assert.deepEqual(checkpoint.runIds, runIds);
  assert.equal(checkpoint.runId, runIds[1]);
  assert.equal(checkpoint.status, "committed");
  const point = (await app.getForkPoints(app.sessionId)).find(item => item.runId === runIds[1]);
  assert.equal(point.available, true);
});

test("real delegated Goal duration stops its child process and releases the Git lease", {
  timeout: 90_000, skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async (t) => {
  const fixture = await goalGitFixture("delegated-duration-goal-");
  let childStarted;
  let childExited;
  const started = new Promise(resolve => { childStarted = resolve; });
  const exited = new Promise(resolve => { childExited = resolve; });
  const processTool = { name: "wait_for_goal_timeout", description: "Start the required child verification process and wait for its termination.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return new Promise((resolve, reject) => {
        const process = fork(fileURLToPath(new URL("./fixtures/goal-long-process.mjs", import.meta.url)), [], {
          signal: context.signal, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        let error;
        process.once("error", cause => { error = cause; });
        process.on("message", message => {
          assert.equal(message.type, "started");
          assert.equal(message.pid, process.pid);
          childStarted(process.pid);
        });
        process.once("exit", (code, signal) => {
          childExited({ code, signal });
          if (error) reject(error);
          else if (code !== 0) reject(new Error(`Child verification process terminated: ${signal ?? code}`));
          else resolve({ completed: true });
        });
      });
    },
  };
  const base = defaultSubagentConfiguration();
  const app = await MaybeCodeWorkspace.open({ ...fixture.options, toolSource: () => [processTool],
    subagents: { dataDirectory: join(fixture.workspace, "..", "delegation"), configuration: {
      ...base, roles: [{ name: "worker", tools: ["read", "write"], delegateTo: [] }],
    } },
  });
  const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
  t.after(async () => { await app.close(); await competitor.close(); await fixture.cleanup(); });
  await app.startGoal("Call delegate_tasks exactly once with one independent worker task. The worker owns only duration.txt and must first use write to create it with exactly DURATION_GOAL followed by a newline, then call wait_for_goal_timeout exactly once and wait for that required verification process. Include its exact files array and a standalone brief with both operations. Do not perform the worker's operations yourself. Do not use shell.", { maxRuns: 2, maxDurationMs: 30_000 });
  const pid = await Promise.race([started, waitForGoal(app).then(() => { throw new Error(`The Goal stopped before its child process started: ${JSON.stringify(app.getGoal())}`); })]);
  await assert.rejects(competitor.submit({ input: "Reply COMPETING_DURATION_PROCESS." }), /Git workspace is already in use/u);
  await waitForGoal(app);
  assert.equal(app.getGoal().status, "budget_exhausted", JSON.stringify(app.getGoal()));
  await exited;
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  assert.equal(await readFile(join(fixture.workspace, "duration.txt"), "utf8"), "DURATION_GOAL\n");
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
  const runIds = (await app.history()).filter(event => event.type === "run.started").map(event => event.runId);
  const checkpoint = await fixture.gitWorkspace.checkpointByRun(app.sessionId, runIds[runIds.length - 1]);
  assert.equal(checkpoint.status, "uncommitted");
  assert.deepEqual(checkpoint.runIds, runIds);
  const released = await competitor.submit({ input: "Reply exactly DURATION_LEASE_RELEASED without tools." });
  assert.match(JSON.stringify((await released.result).message), /DURATION_LEASE_RELEASED/u);
  assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
});
