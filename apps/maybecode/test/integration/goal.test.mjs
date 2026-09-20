import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { NodeTerminalDriver } from "@may/tui";
import { loadMayConfig } from "@may/config";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { openConfiguredMaybeCode, executeMaybeCodeSlashCommand, createMaybeCodeWebHost, runRetainedTerminalUI, runTerminalUI, createNodeTerminal, MaybeCodeWorkspace, createMaybeCodeModel, selectMaybeCodeModel, createCodingPermissionPolicy } from "../../dist/index.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));

async function open(t, extra = {}) {
  const parent = join(workspace, "review", "goal-tests");
  await mkdir(parent, { recursive: true });
  const dataDirectory = await mkdtemp(join(parent, "session-"));
  const options = { workspace, dataDirectory, model: "deepseek-v4-flash", autoResume: false,
    mcp: false, observability: false, skills: false, retry: false, maxSteps: 8, ...extra };
  const app = extra.permissionPolicy === undefined ? await openConfiguredMaybeCode(options) : await MaybeCodeWorkspace.open({
    workspace, store: new FileSessionStore(join(dataDirectory, "sessions")), catalog: new FileSessionCatalog(join(dataDirectory, "catalog")),
    model: createMaybeCodeModel(selectMaybeCodeModel(await loadMayConfig(), { model: "deepseek-v4-flash" })),
    permissionPolicy: extra.permissionPolicy, skills: false,
  });
  t.after(() => app.close());
  return { app, options };
}

async function stopped(app) {
  const deadline = Date.now() + 150_000;
  while (app.isRunning && Date.now() < deadline) await delay(20);
  assert.equal(app.isRunning, false, "goal did not stop within the test deadline");
  return app.getGoal();
}

async function drain(app) {
  for await (const event of app.events) {
    if (event.type === "permission.event" && event.event.type === "approval.requested") {
      await app.resolveApproval(event.event.request.id, "deny");
      app.cancel("Integration test requested read-only execution");
    }
  }
}

test("real provider drives two goal runs, durable completion, token limits and Web controls", { timeout: 240_000 }, async t => {
  const { app, options } = await open(t);
  const host = createMaybeCodeWebHost(app, { closeApplication: false });
  t.after(() => host.close());
  const slash = text => host.execute({ hostId: host.hostId, targetId: app.sessionId, requestId: crypto.randomUUID(), name: "console.execute", args: { text } });
  await slash('/goal start --tokens 60000 -- This is a two-run verification task. Call get_goal to inspect usage.runs. When usage.runs is 1, reply with READY and end your response without update_goal. When usage.runs is 2, use read to inspect the first 10 lines of README.md, then call update_goal with status completed and evidence stating its first heading. Do not modify files or use shell.');
  const goal = await stopped(app);
  assert.equal(goal.status, "completed", JSON.stringify(goal));
  assert.equal(goal.usage.runs, 2);
  assert.deepEqual(goal.budget, { maxTotalTokens: 60000 });
  assert.ok(goal.usage.totalTokens > 0);
  assert.equal(goal.completion.source, "model");
  const history = await app.history();
  assert.equal(history.filter(event => event.type === "input.submitted").length, 1);
  assert.equal(history.filter(event => event.type === "run.started").length, 2);
  assert.ok(history.some(event => event.type === "tool.completed" && event.call.name === "read"));
  assert.match((await slash("/goal status")).output.text, /Status: completed/u);
  assert.ok((await host.snapshot()).panels.some(panel => panel.id === "goal"));
  const id = app.sessionId;
  await host.close();
  await app.close();
  const resumed = await openConfiguredMaybeCode({ ...options, sessionId: id });
  t.after(() => resumed.close());
  const relay = drain(resumed);
  assert.deepEqual(resumed.getGoal(), goal);
  await executeMaybeCodeSlashCommand("/goal start --tokens 1 -- Reply with OK and finish the goal.", resumed);
  const exhausted = await stopped(resumed);
  assert.equal(exhausted.status, "budget_exhausted", JSON.stringify(exhausted));
  assert.ok(exhausted.usage.totalTokens > 1);
  await resumed.cancelGoal();
  await resumed.startGoal("Report blocked using update_goal because the required file name has not been supplied. Do not call other tools.");
  assert.equal((await stopped(resumed)).status, "blocked");
  await resumed.cancelGoal();
  await resumed.close();
  await relay;
});

test("goal pauses before a model request, survives reopen, and accepts a fresh user message", { timeout: 180_000 }, async t => {
  const { app, options } = await open(t);
  const relay = drain(app);
  await app.startGoal("Read the first 3 lines of README.md and report its first heading through update_goal completed. Do not use shell or modify files.");
  assert.deepEqual(app.getGoal().budget, {});
  await app.pauseGoal();
  const paused = app.getGoal();
  assert.equal(paused.status, "paused");
  assert.equal(app.isRunning, false);
  const id = app.sessionId;
  await app.close(); await relay;
  const resumed = await openConfiguredMaybeCode({ ...options, sessionId: id });
  t.after(() => resumed.close());
  const resumedRelay = drain(resumed);
  assert.equal(resumed.getGoal().status, "paused");
  assert.deepEqual(resumed.getGoal().budget, {});
  const status = await executeMaybeCodeSlashCommand("/goal status", resumed);
  assert.match(status.text, /Runs: \d+\/unlimited/u);
  assert.match(status.text, /Active time: \d+\/unlimited ms/u);
  assert.equal(resumed.getGoal().usage.totalTokens, paused.usage.totalTokens);
  await resumed.resumeGoal();
  assert.equal((await stopped(resumed)).status, "completed");
  await resumed.startGoal("Read README.md, report progress, then finish the goal.");
  const run = await resumed.submit({ input: "Reply with exactly USER_MESSAGE_OK. Do not use tools." });
  const result = await run.result;
  assert.match(result.message.content.filter(part => part.type === "text").map(part => part.text).join(""), /USER_MESSAGE_OK/u);
  assert.equal(resumed.getGoal().status, "paused");
  await resumed.close(); await resumedRelay;
});

test("explicit run and duration limits stop goal execution independently", { timeout: 90_000 }, async t => {
  const { app } = await open(t);
  const relay = drain(app);
  await executeMaybeCodeSlashCommand("/goal start --max-runs 1 -- Call get_goal, then reply with READY. This is a multi-run goal: do not report completed or blocked during the first run.", app);
  const runs = await stopped(app);
  assert.equal(runs.status, "budget_exhausted", JSON.stringify(runs));
  assert.equal(runs.usage.runs, 1);
  assert.deepEqual(runs.budget, { maxRuns: 1 });
  assert.match(runs.reason, /run budget exhausted/u);
  await app.cancelGoal();
  await executeMaybeCodeSlashCommand("/goal start --duration-ms 1 -- Read README.md and report its heading.", app);
  const duration = await stopped(app);
  assert.equal(duration.status, "budget_exhausted", JSON.stringify(duration));
  assert.deepEqual(duration.budget, { maxDurationMs: 1 });
  assert.match(duration.reason, /duration budget exhausted/u);
  await app.close(); await relay;
});

for (const retained of [false, true]) {
  test(`real ${retained ? "retained" : "readline"} terminal executes goal commands`, { timeout: 90_000 }, async t => {
    const policy = createCodingPermissionPolicy();
    const { app } = await open(t, retained ? {} : { permissionPolicy: check => check.tool.name === "read" ? "ask" : policy(check) });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    let approvalCount = 0;
    output.on("data", chunk => {
      const value = chunk.toString();
      text += value;
      if (!retained && value.includes("[a]llow once")) { approvalCount++; setImmediate(() => input.write("a\n")); }
    });
    const terminal = retained ? new NodeTerminalDriver({ input, output, requireTTY: false }) : createNodeTerminal({ input, output });
    const task = retained ? runRetainedTerminalUI(app, { terminal }) : runTerminalUI(app, { terminal });
    t.after(async () => { input.destroy(); await app.close(); terminal.close(); });
    await delay(40);
    input.write("/goal start --max-runs 3 -- Use read to inspect the first 3 lines of README.md, then update_goal completed with evidence of the first heading. Do not use shell or modify files.\r\n");
    const deadline = Date.now() + 60_000;
    while (!app.getGoal() && Date.now() < deadline) await delay(20);
    assert.ok(app.getGoal(), stripVTControlCharacters(text).slice(-2000));
    assert.equal((await stopped(app)).status, "completed");
    if (!retained) assert.ok(approvalCount > 0, "read approval must be handled while goal input is active");
    input.write("/goal status\r\n");
    await delay(100);
    assert.match(stripVTControlCharacters(text), /completed/u);
    input.write("/quit\r\n");
    await task;
  });
}

test("goals disabled leaves ordinary runs free of goal tools and state", { timeout: 60_000 }, async t => {
  const { app } = await open(t, { goals: false });
  const relay = drain(app);
  assert.equal(app.getGoal(), undefined);
  await assert.rejects(app.startGoal("unused"), /disabled/u);
  await (await app.submit({ input: "Reply with exactly ORDINARY_OK. Do not call tools." })).result;
  assert.equal((await app.history()).some(event => event.type === "state.updated" && event.key === "may.goal"), false);
  await app.close(); await relay;
});

test("process interruption restores a paused goal with unknown usage and no automatic replay", { timeout: 60_000 }, async t => {
  const parent = join(workspace, "review", "goal-tests");
  await mkdir(parent, { recursive: true });
  const dataDirectory = await mkdtemp(join(parent, "crash-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/goal-crash.mjs", import.meta.url)), workspace, dataDirectory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(() => child.kill());
  let output = "", diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not reach a persisted pending call: ${diagnostics}`)), 30_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); if (!output.includes("PENDING")) reject(new Error(diagnostics || "Child exited before dispatch")); });
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("PENDING")) { clearTimeout(timer); child.kill(); resolve(); }
    });
  });
  await exited;
  const sessionId = /SESSION:([^\r\n]+)/u.exec(output)?.[1];
  assert.ok(sessionId);
  const app = await openConfiguredMaybeCode({ workspace, dataDirectory, sessionId, model: "deepseek-v4-flash", mcp: false, observability: false, skills: false, retry: false });
  t.after(() => app.close());
  const relay = drain(app);
  assert.equal(app.isRunning, false);
  assert.equal(app.getGoal().status, "paused");
  assert.equal(app.getGoal().usage.usageComplete, false);
  assert.ok(app.getGoal().calls.some(call => call.status === "unknown"));
  await assert.rejects(app.resumeGoal(), /unknown/u);
  await app.cancelGoal();
  assert.equal(app.getGoal().status, "cancelled");
  await app.close(); await relay;
});
