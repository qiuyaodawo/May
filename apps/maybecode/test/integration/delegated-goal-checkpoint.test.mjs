import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { liveModelProfile } from "../fixtures/live-model.mjs";
import { goalGitFixture, waitForGoal } from "../fixtures/goal-git.mjs";
import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import { defaultSubagentConfiguration } from "@sortedyuan/coordination/delegation";
import { MaybeCodeWorkspace } from "../../dist/workspace.js";

test(
  "real delegated Goal meters a role model and saves one completed request checkpoint",
  {
    timeout: 120_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("delegated-role-goal-");
    const config = await loadMayConfig();
    let roleModels = 0;
    const base = defaultSubagentConfiguration();
    const app = await MaybeCodeWorkspace.open({
      ...fixture.options,
      subagents: {
        dataDirectory: join(fixture.workspace, "..", "delegation"),
        createRoleModel(role) {
          assert.equal(role.model, liveModelProfile());
          roleModels++;
          return createBuiltinProviderModel(selectProviderModel(config, { model: role.model }));
        },
        configuration: {
          ...base,
          roles: [{ name: "worker", model: liveModelProfile(), tools: ["read", "write", "edit"], delegateTo: [] }],
        },
      },
    });
    t.after(async () => {
      await app.close();
      await fixture.cleanup();
    });
    await app.startGoal(
      "Call delegate_tasks exactly once with one independent worker task. The worker owns only role-child.txt and must use write to create it with exactly ROLE_CHILD_GOAL followed by a newline. Include its exact files array and a standalone brief. After the child finishes, read role-child.txt and then call update_goal completed with the file contents as evidence. Do not write the file yourself. Do not use shell.",
      { maxRuns: 2 },
    );
    await waitForGoal(app);
    const goal = app.application.getGoal();
    assert.equal(goal.status, "completed", JSON.stringify(goal));
    assert.ok(roleModels > 0);
    assert.equal(goal.usage.usageComplete, true);
    const child = app.application.getDelegationState().tasks.find((task) => task.depth === 2);
    assert.equal(child.status, "completed");
    const childRunIds = (await fixture.options.store.inspect(child.sessionId))
      .filter((event) => event.type === "run.started")
      .map((event) => event.runId);
    assert.ok(childRunIds.length > 0);
    const childCalls = goal.calls.filter((call) => childRunIds.includes(call.runId));
    assert.ok(childCalls.length > 0, "The role-specific child's actual model calls must be metered by the Goal");
    assert.ok(childCalls.every((call) => call.status === "settled" && call.tokens > 0));
    assert.equal(
      goal.usage.totalTokens,
      goal.calls.reduce((total, call) => total + call.tokens, 0),
    );
    assert.equal(await readFile(join(fixture.workspace, "role-child.txt"), "utf8"), "ROLE_CHILD_GOAL\n");
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "2");
    const runIds = (await app.history()).filter((event) => event.type === "run.started").map((event) => event.runId);
    assert.equal(runIds.length, 2);
    const checkpoint = await fixture.gitWorkspace.checkpointByRun(app.sessionId, runIds[1]);
    assert.deepEqual(checkpoint.runIds, runIds);
    assert.equal(checkpoint.runId, runIds[1]);
    assert.equal(checkpoint.status, "committed");
    const point = (await app.getForkPoints(app.sessionId)).find((item) => item.runId === runIds[1]);
    assert.equal(point.available, true);
  },
);

test(
  "real delegated Goal duration stops its child process and releases the Git lease",
  {
    timeout: 90_000,
    skip: process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  },
  async (t) => {
    const fixture = await goalGitFixture("delegated-duration-goal-");
    let childStarted;
    let childExited;
    const started = new Promise((resolve) => {
      childStarted = resolve;
    });
    const exited = new Promise((resolve) => {
      childExited = resolve;
    });
    const processTool = {
      name: "wait_for_goal_timeout",
      description: "Start the required child verification process and wait for its termination.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) {
        return new Promise((resolve, reject) => {
          const process = fork(fileURLToPath(new URL("./fixtures/goal-long-process.mjs", import.meta.url)), [], {
            signal: context.signal,
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
          let error;
          process.once("error", (cause) => {
            error = cause;
          });
          process.on("message", (message) => {
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
    const app = await MaybeCodeWorkspace.open({
      ...fixture.options,
      toolSource: () => [processTool],
      subagents: {
        dataDirectory: join(fixture.workspace, "..", "delegation"),
        configuration: {
          ...base,
          roles: [{ name: "worker", tools: ["read", "write"], delegateTo: [] }],
        },
      },
    });
    const competitor = await MaybeCodeWorkspace.open({ ...fixture.options, goals: false });
    t.after(async () => {
      await app.close();
      await competitor.close();
      await fixture.cleanup();
    });
    await app.startGoal(
      "Call delegate_tasks exactly once with one independent worker task. The worker owns only duration.txt and must first use write to create it with exactly DURATION_GOAL followed by a newline, then call wait_for_goal_timeout exactly once and wait for that required verification process. Include its exact files array and a standalone brief with both operations. Do not perform the worker's operations yourself. Do not use shell.",
      { maxRuns: 2, maxDurationMs: 30_000 },
    );
    const pid = await Promise.race([
      started,
      waitForGoal(app).then(() => {
        throw new Error(
          `The Goal stopped before its child process started: ${JSON.stringify(app.application.getGoal())}`,
        );
      }),
    ]);
    await assert.rejects(
      fixture.gitWorkspace.beginRound({ sessionId: competitor.sessionId }),
      /Git workspace is already in use/u,
    );
    await waitForGoal(app);
    assert.equal(app.application.getGoal().status, "budget_exhausted", JSON.stringify(app.application.getGoal()));
    await exited;
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    assert.equal(await readFile(join(fixture.workspace, "duration.txt"), "utf8"), "DURATION_GOAL\n");
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
    const runIds = (await app.history()).filter((event) => event.type === "run.started").map((event) => event.runId);
    const checkpoint = await fixture.gitWorkspace.checkpointByRun(app.sessionId, runIds[runIds.length - 1]);
    assert.equal(checkpoint.status, "uncommitted");
    assert.deepEqual(checkpoint.runIds, runIds);
    const released = await competitor.submit({ input: "Reply exactly DURATION_LEASE_RELEASED without tools." });
    assert.match(JSON.stringify((await released.result).message), /DURATION_LEASE_RELEASED/u);
    assert.equal(await fixture.git("rev-list", "--count", "HEAD"), "1");
  },
);
