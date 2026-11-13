import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { goalGitFixture, waitForGoal } from "../fixtures/goal-git.mjs";
import { createGoalsPlugin } from "@sortedyuan/may/goals/plugin";
import { GoalController } from "@sortedyuan/may/goals";
import { InMemoryContextFactory } from "@sortedyuan/may/context";
import { MaybeCodeApplication } from "../../dist/application.js";
import { MaybeCodeWorkspace } from "../../dist/workspace.js";
import { gitRequestService, startGitGoalRequest } from "../../dist/git-request.js";

test(
  "real completed Goal saves its final files and a recoverable yielded position",
  {
    timeout: 120_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("completed-goal-");
    const app = await MaybeCodeWorkspace.open(fixture.options);
    t.after(async () => {
      await app.close();
      await fixture.cleanup();
    });
    await app.startGoal(
      "Use write to create goal.txt containing exactly COMPLETED_GOAL followed by a newline, then call update_goal with status completed and evidence that the requested file was written. Do not use shell.",
    );
    await waitForGoal(app);
    assert.equal(app.application.getGoal().status, "completed", JSON.stringify(app.application.getGoal()));
    assert.equal(await readFile(join(fixture.workspace, "goal.txt"), "utf8"), "COMPLETED_GOAL\n");
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
    const history = await app.history();
    const final = [...history].reverse().find((event) => event.type === "run.yielded");
    assert.ok(final);
    assert.equal(
      history.some(
        (event) => event.type === "run.settled" && event.runId === final.runId && event.hostCompleted === true,
      ),
      true,
    );
    const point = (await app.getForkPoints(app.sessionId)).find((point) => point.runId === final.runId);
    assert.equal(point.available, true);
    assert.equal(point.worktreeAvailable, true);
    assert.equal(
      (await fixture.gitWorkspace.checkpointByRun(app.sessionId, final.runId)).historyPosition,
      Number(point.id.slice(app.sessionId.length + 1)),
    );
    const forkId = await app.forkSession(point.id, "current");
    assert.notEqual(forkId, final.sessionId);
    assert.equal(app.application.getGoal(), undefined);
    assert.equal((await app.getForkPoints(forkId)).find((item) => item.runId === final.runId).available, true);
  },
);

test(
  "real Goal verification owns the Git lease and saves files after accepted verification",
  {
    timeout: 180_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("verified-goal-");
    let competitor;
    let checks = 0;
    const plugin = createGoalsPlugin({
      async verify() {
        checks++;
        assert.equal(await fixture.git("rev-list", "--count", "HEAD"), String(checks));
        await assert.rejects(
          fixture.gitWorkspace.beginRound({ sessionId: competitor.sessionId }),
          /Git workspace is already in use/u,
        );
        const contents = await readFile(join(fixture.workspace, "goal.txt"), "utf8");
        return {
          completed: contents === "VERIFIED_GOAL\n",
          evidence:
            "goal.txt must contain exactly VERIFIED_GOAL followed by a newline. Use write to correct it and request completion again.",
        };
      },
      createAgent: (application) => ({
        sessionId: application.sessionId,
        get isRunning() {
          return application.isRunning;
        },
        submit: (options) =>
          startGitGoalRequest(
            application.getService(gitRequestService),
            application.sessionId,
            () => application.submit(options),
            () => {},
            (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
            async (runId) =>
              (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          ),
        continue: (options) =>
          startGitGoalRequest(
            application.getService(gitRequestService),
            application.sessionId,
            () => application.continue(options),
            () => {},
            (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
            async (runId) =>
              (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          ),
      }),
    });
    const app = await MaybeCodeWorkspace.open({ ...fixture.options, plugins: [plugin] });
    competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
    t.after(async () => {
      await app.close();
      await competitor.close();
      await fixture.cleanup();
    });
    await app.startGoal(
      "Call get_goal at the beginning of every Run. When usage.runs is 1, use write to create goal.txt containing exactly NEEDS_VERIFICATION followed by a newline, then update_goal completed. During subsequent Runs, follow the verifier's correction in goal.progress and request completion again. Do not use shell.",
      { maxRuns: 3 },
    );
    await waitForGoal(app);
    assert.equal(app.application.getGoal().status, "completed", JSON.stringify(app.application.getGoal()));
    assert.equal(app.application.getGoal().completion.source, "verifier");
    assert.equal(checks, 2);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "3");
    const yielded = (await app.history()).filter((event) => event.type === "run.yielded");
    assert.equal(yielded.length, 2);
    const points = await app.getForkPoints(app.sessionId);
    assert.equal(points.find((point) => point.runId === yielded[0].runId).available, false);
    assert.equal(points.find((point) => point.runId === yielded[1].runId).available, true);
    assert.equal(points.find((point) => point.runId === yielded[1].runId).worktreeAvailable, true);
    const next = await competitor.submit({ input: "Reply exactly VERIFIED_LEASE_RELEASED without tools." });
    assert.match(JSON.stringify((await next.result).message), /VERIFIED_LEASE_RELEASED/u);
  },
);

test(
  "public Goal adapter forwards continuation options and finalizes actual file checkpoints",
  {
    timeout: 120_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("public-goal-adapter-");
    const goals = new GoalController();
    const app = await MaybeCodeApplication.open({
      ...fixture.options,
      goals: false,
      model: goals.wrapModel(fixture.options.model),
      contextFactory: goals.wrapContextFactory(new InMemoryContextFactory()),
      toolSource: () => goals.tools(),
      gitWorkspace: fixture.gitWorkspace,
    });
    t.after(async () => {
      await goals.close();
      await app.close();
      await fixture.cleanup();
    });
    await goals.attach(app.goalAgent(), {
      async read() {
        return existsSync(fixture.statePath) ? JSON.parse(await readFile(fixture.statePath, "utf8")) : undefined;
      },
      async write(state) {
        await writeFile(fixture.statePath, JSON.stringify(state));
      },
    });
    await goals.start(
      "Call get_goal at the beginning of each Run. When usage.runs is 1, use write to create first.txt containing exactly FIRST_GOAL_RUN followed by a newline, then reply READY without update_goal. When usage.runs is 2, create second.txt containing exactly FINAL_GOAL_RUN followed by a newline, then update_goal completed. Do not use shell.",
      { maxRuns: 2 },
    );
    await goals.wait();
    assert.equal(goals.getGoal().status, "completed", JSON.stringify(goals.getGoal()));
    assert.equal(goals.getGoal().usage.runs, 2);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "3");
    assert.equal(await readFile(join(fixture.workspace, "first.txt"), "utf8"), "FIRST_GOAL_RUN\n");
    assert.equal(await readFile(join(fixture.workspace, "second.txt"), "utf8"), "FINAL_GOAL_RUN\n");
    const history = await app.history();
    assert.equal(history.filter((event) => event.type === "input.submitted").length, 1);
    const final = [...history].reverse().find((event) => event.type === "run.yielded");
    assert.ok(final, "Goal continuation must retain its shouldYield option");
    const position = (await app.branchPositions()).find((position) => position.runId === final.runId);
    assert.equal(position.available, true);
    assert.equal(
      (await fixture.gitWorkspace.checkpointByRun(app.sessionId, final.runId)).historyPosition,
      position.positionSeq,
    );
  },
);

test(
  "real verification failure and cancellation release the Goal lease with uncommitted files",
  {
    timeout: 180_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("failed-goal-");
    let verification = "missing-file";
    let resolveVerification;
    const verificationStarted = new Promise((resolve) => {
      resolveVerification = resolve;
    });
    const plugin = createGoalsPlugin({
      async verify(_state, signal) {
        if (verification === "missing-file") {
          await readFile(join(fixture.workspace, "required-evidence.txt"), "utf8");
          return { completed: true, evidence: "Required evidence was read." };
        }
        assert.equal(await readFile(join(fixture.workspace, "cancelled.txt"), "utf8"), "CANCELLED_GOAL\n");
        signal.throwIfAborted();
        resolveVerification();
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        signal.throwIfAborted();
        return { completed: true, evidence: "Cancellation verification finished." };
      },
      createAgent: (application) => ({
        sessionId: application.sessionId,
        get isRunning() {
          return application.isRunning;
        },
        submit: (options) =>
          startGitGoalRequest(
            application.getService(gitRequestService),
            application.sessionId,
            () => application.submit(options),
            () => {},
            (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
            async (runId) =>
              (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          ),
        continue: (options) =>
          startGitGoalRequest(
            application.getService(gitRequestService),
            application.sessionId,
            () => application.continue(options),
            () => {},
            (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
            async (runId) =>
              (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          ),
      }),
    });
    const app = await MaybeCodeWorkspace.open({ ...fixture.options, plugins: [plugin] });
    const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
    t.after(async () => {
      await app.close();
      await competitor.close();
      await fixture.cleanup();
    });
    await app.startGoal(
      "Use write to create retained.txt containing exactly RETAINED_GOAL followed by a newline, then update_goal completed. Do not create any other files. Do not use shell.",
    );
    await waitForGoal(app);
    assert.equal(app.application.getGoal().status, "failed");
    assert.match(app.application.getGoal().reason, /ENOENT/u);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
    assert.match(await fixture.git("status", "--porcelain"), /retained\.txt/u);
    assert.equal(
      (await app.getForkPoints(app.sessionId)).some((point) => point.available),
      false,
    );
    const afterFailure = await competitor.submit({ input: "Reply exactly FAILURE_LEASE_RELEASED without tools." });
    assert.match(JSON.stringify((await afterFailure.result).message), /FAILURE_LEASE_RELEASED/u);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
    await app.cancelGoal();
    verification = "wait-for-cancellation";
    await app.startGoal(
      "Use write to create cancelled.txt containing exactly CANCELLED_GOAL followed by a newline, then update_goal completed. Do not create any other files. Do not use shell.",
    );
    await verificationStarted;
    await assert.rejects(
      fixture.gitWorkspace.beginRound({ sessionId: competitor.sessionId }),
      /Git workspace is already in use/u,
    );
    assert.equal((await app.pauseGoal()).status, "paused");
    assert.equal(app.isRunning, false);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
    assert.match(await fixture.git("status", "--porcelain"), /cancelled\.txt/u);
    assert.equal(
      (await app.getForkPoints(app.sessionId)).some((point) => point.available),
      false,
    );
    const afterCancellation = await competitor.submit({
      input: "Reply exactly CANCELLATION_LEASE_RELEASED without tools.",
    });
    assert.match(JSON.stringify((await afterCancellation.result).message), /CANCELLATION_LEASE_RELEASED/u);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
  },
);
