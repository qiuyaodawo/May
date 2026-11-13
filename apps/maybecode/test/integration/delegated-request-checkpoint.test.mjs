import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { liveModelProfile } from "../fixtures/live-model.mjs";
import { artifacts, execute, goalGitFixture, waitForGoal } from "../fixtures/goal-git.mjs";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import { defaultSubagentConfiguration } from "@sortedyuan/coordination/delegation";
import { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import { runtimeHooks } from "@sortedyuan/may/core";
import { MaybeCodeWorkspace } from "../../dist/workspace.js";

test(
  "real delegated requests keep the Git lease through child tasks and the final main Run",
  {
    timeout: 180_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
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
    const model = createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: liveModelProfile() }));
    const base = defaultSubagentConfiguration();
    const options = {
      workspace,
      model,
      store: new FileSessionStore(join(directory, "sessions")),
      catalog: new FileSessionCatalog(join(directory, "catalog.json")),
      goals: false,
      skills: false,
      permissionPolicy: (check) => (["shell", "bash"].includes(check.tool.name) ? "deny" : "allow"),
      instructions:
        "Delegate the explicitly requested independent file tasks through delegate_tasks. The main agent must wait for the child outcomes, then read their files and report completion. Keep final replies short. Do not run shell commands.",
      subagents: {
        dataDirectory: join(directory, "delegation"),
        configuration: {
          ...base,
          roles: [{ name: "worker", tools: ["read", "write", "edit"], delegateTo: [] }],
          limits: { ...base.limits, maxTasks: 3, maxConcurrent: 2, maxDepth: 2 },
        },
      },
      git: {
        dataRoot: join(directory, "records"),
        authorizeCommit(request) {
          assert.equal(resolve(request.workspace), resolve(workspace));
          return true;
        },
      },
    };
    const app = await MaybeCodeWorkspace.open(options);
    const competitor = await MaybeCodeWorkspace.open({ ...options, subagents: false });
    let resolveChildrenRunning;
    const childrenRunning = new Promise((resolve) => {
      resolveChildrenRunning = resolve;
    });
    let resolveFinalRun;
    const finalRun = new Promise((resolve) => {
      resolveFinalRun = resolve;
    });
    let mainRunCount = 0;
    const events = [];
    const observing = (async () => {
      for await (const event of app.events) {
        events.push(event);
        if (
          event.type === "delegation.updated" &&
          event.state.tasks.some((task) => task.depth === 2 && task.status === "running")
        ) {
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
    assert.equal((await app.getWorkspaceGit()).commit, undefined);
    const request = await app.submit({
      input:
        "Call delegate_tasks exactly once with two independent worker tasks. Task child-a owns only child-a.txt and must create it with exactly CHILD_A followed by a newline. Task child-b owns only child-b.txt and must create it with exactly CHILD_B followed by a newline. Give each task a standalone brief and the exact files array. After both tasks finish, use read to inspect both files, then report their two markers. Do not create or edit these files yourself. Do not use shell.",
    });
    await Promise.race([
      childrenRunning,
      request.result.then(() => {
        throw new Error("The request finished before a child task ran");
      }),
    ]);
    await Promise.race([
      finalRun,
      request.result.then(() => {
        throw new Error("The request finished without a second main Run");
      }),
    ]);
    assert.equal(await git("rev-list", "--count", "HEAD"), "1");
    const workspaceFiles = await ProjectGitWorkspace.open({ ...options.git, workspace });
    await assert.rejects(
      workspaceFiles.beginRound({ sessionId: competitor.sessionId }),
      /Git workspace is already in use/u,
    );
    const result = await request.result;
    const runs = await request.runs();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].result.finishReason, "yielded");
    assert.equal(result.runId, runs[1].runId);
    assert.equal(await git("rev-list", "--count", "HEAD"), "2");
    assert.equal(await readFile(join(workspace, "child-a.txt"), "utf8"), "CHILD_A\n");
    assert.equal(await readFile(join(workspace, "child-b.txt"), "utf8"), "CHILD_B\n");
    const state = app.application.getDelegationState();
    assert.equal(state.status, "completed");
    assert.equal(state.tasks.filter((task) => task.depth === 2 && task.status === "completed").length, 2);
    assert.deepEqual(
      state.mainRunIds,
      runs.map((run) => run.runId),
    );
    const points = await app.getForkPoints(app.sessionId);
    assert.equal(points.find((point) => point.runId === runs[0].runId).available, false);
    assert.equal(points.find((point) => point.runId === runs[1].runId).available, true);
    assert.equal(points.find((point) => point.runId === runs[1].runId).worktreeAvailable, true);
    const changes = await app.getChanges({ scope: "run", runId: runs[1].runId });
    assert.deepEqual(new Set(changes.files.map((file) => file.path)), new Set(["child-a.txt", "child-b.txt"]));
    assert.equal(
      events.filter((event) => event.type === "workspace.git.changed" && event.checkpoint.status === "committed")
        .length,
      1,
    );
    const next = await competitor.submit({ input: "Reply exactly LEASE_RELEASED without tools." });
    assert.match(JSON.stringify((await next.result).message), /LEASE_RELEASED/u);
    assert.equal(await git("rev-list", "--count", "HEAD"), "2");
  },
);

for (const mode of ["request", "Goal"]) {
  for (const outcome of ["failure", "cancellation"]) {
    test(
      `real delegated ${mode} ${outcome} checkpoints retain every main Run identity`,
      {
        timeout: 120_000,
        skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
      },
      async (t) => {
        const fixture = await goalGitFixture(`delegated-${mode}-${outcome}-`);
        let reportRunStarted;
        const reportRun = new Promise((resolve) => {
          reportRunStarted = resolve;
        });
        let observedMainRuns = 0;
        const requiredEvidence = {
          id: "verification.required-delegated-evidence",
          version: "1.0.0",
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
        const app = await MaybeCodeWorkspace.open({
          ...fixture.options,
          goals: mode === "Goal" ? {} : false,
          plugins: [requiredEvidence],
          subagents: {
            dataDirectory: join(fixture.workspace, "..", "delegation"),
            configuration: {
              ...base,
              roles: [{ name: "worker", tools: ["read", "write", "edit"], delegateTo: [] }],
            },
          },
        });
        const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
        t.after(async () => {
          await app.close();
          await competitor.close();
          await fixture.cleanup();
        });
        const input =
          "Call delegate_tasks exactly once with one independent worker task. The worker owns only child.txt and must use write to create it with exactly CHILD_EVIDENCE followed by a newline. Include its exact files array and a standalone brief. Wait for its result, then read child.txt and report completion. Do not write the file yourself. Do not use shell.";
        let request;
        let requestError;
        if (mode === "request") {
          request = await app.submit({ input });
          requestError = request.result.then(
            () => {
              throw new Error("The delegated request unexpectedly completed");
            },
            (error) => error,
          );
          await Promise.race([
            reportRun,
            requestError.then((error) => {
              throw error;
            }),
          ]);
        } else {
          await app.startGoal(input, { maxRuns: 2 });
          await Promise.race([
            reportRun,
            waitForGoal(app).then(() => {
              throw new Error(
                `The Goal finished before its report Run started: ${JSON.stringify(app.application.getGoal())}; observed main Runs: ${observedMainRuns}; delegation: ${JSON.stringify(app.application.getDelegationState())}`,
              );
            }),
          ]);
        }
        const lastRunId = await reportRun;
        if (outcome === "cancellation") {
          await assert.rejects(
            fixture.gitWorkspace.beginRound({ sessionId: competitor.sessionId }),
            /Git workspace is already in use/u,
          );
          if (mode === "request") request.cancel("Cancel the delegated report Run");
          else assert.equal((await app.cancelGoal()).status, "cancelled");
        }
        if (mode === "request") {
          const error = await requestError;
          assert.match(String(error), outcome === "failure" ? /ENOENT/u : /Cancel|cancel/u);
        } else {
          await waitForGoal(app);
          assert.equal(
            app.application.getGoal().status,
            outcome === "failure" ? "failed" : "cancelled",
            JSON.stringify(app.application.getGoal()),
          );
        }
        const runIds = (await app.history())
          .filter((event) => event.type === "run.started")
          .map((event) => event.runId);
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
        assert.deepEqual(
          changes.files.map((file) => file.path),
          ["child.txt"],
        );
        assert.equal(
          (await app.getForkPoints(app.sessionId)).some((point) => point.available),
          false,
        );
        const released = await competitor.submit({ input: "Reply exactly REPORT_LEASE_RELEASED without tools." });
        assert.match(JSON.stringify((await released.result).message), /REPORT_LEASE_RELEASED/u);
        assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
      },
    );
  }
}
