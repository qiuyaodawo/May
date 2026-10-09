import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import treeKill from "tree-kill";
import { EvalRunner, EvalRegistry, createLocalDirectoryEnvironment, createNodeCommandExecutionAdapter, createFileChangesEvaluator, createNodeCommandEvaluator, createHumanEvaluator, createEvalPlan, compareEvalReports } from "../dist/index.js";
import { FileEvalStore } from "../dist/file-store.js";

const sourceDirectory = fileURLToPath(new URL("./fixtures/runner-input", import.meta.url));
const action = fileURLToPath(new URL("./fixtures/runner-input/action.mjs", import.meta.url));
const verify = fileURLToPath(new URL("./fixtures/runner-input/verify.mjs", import.meta.url));
async function setup(id, options = {}, source = sourceDirectory) {
  const root = fileURLToPath(new URL("../../../.eval-results/runner-tests", import.meta.url)); await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, "run-"));
  const store = new FileEvalStore({ directory: join(directory, "store") });
  const registry = new EvalRegistry().registerEnvironment(createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(directory, "workspaces") }))
    .registerExecution(createNodeCommandExecutionAdapter({ id: "command", version: "1", command(context) { return { script: action, args: [context.options.mode ?? "success"], cwd: context.target.workspacePath }; } }))
    .registerEvaluator(createFileChangesEvaluator({ id: "files", allowedPaths: ["result.txt", "process.json"], requirements: [{ path: "result.txt", equals: "completed\n" }] }))
    .registerEvaluator(createNodeCommandEvaluator({ id: "verify", version: "1", command(context) { return { script: verify, cwd: context.target.workspacePath }; } }))
    .registerEvaluator(createNodeCommandEvaluator({ id: "optional", version: "1", command(context) { return { script: verify, cwd: context.target.workspacePath }; }, expectedExitCode: 2 }))
    .registerEvaluator(createHumanEvaluator());
  const experiment = { id, repetitions: 1, concurrency: 1, seed: 42,
    cases: [{ id: "write-result", version: "1", description: "Write a result file", input: [{ role: "user", content: [{ type: "text", text: "Write a result file" }] }], environment: { id: "local-directory", version: "1" }, evaluators: [{ id: "files", version: "1", required: true }, { id: "optional", version: "1", required: false }], limits: { prepareTimeoutMs: 5_000, executionTimeoutMs: 5_000, evaluationTimeoutMs: 5_000, cleanupTimeoutMs: 5_000, runBudget: {} } }], variants: [{ id: "external", version: "1", execution: { id: "command", version: "1" }, configuration: {} }], ...options };
  return { directory, store, registry, experiment, runner: new EvalRunner({ registry, store }) };
}
test("runner executes isolated repeated real processes and preserves independent verdicts", async () => {
  const context = await setup("repeated");
  context.experiment.repetitions = 2; context.experiment.concurrency = 2;
  context.experiment.variants.push({ ...context.experiment.variants[0], id: "second" });
  try {
    const report = await context.runner.run(context.experiment); assert.equal(report.planned, 4); assert.equal(report.recorded, 4);
    assert.equal(new Set(report.trials.map(value => value.environmentId)).size, 4);
    for (const state of report.trials) {
      assert.equal(state.executionStatus, "completed"); assert.equal(state.taskVerdict, "passed"); assert.equal(state.infrastructureStatus, "ready");
      assert.equal(state.evaluations.find(value => value.evaluatorId === "optional").result.verdict, "failed");
      assert.equal(state.metrics.modelCalls.value, undefined); assert.equal(state.metrics.totalTokens.value, undefined); assert.equal(state.metrics.cost.amount, undefined); assert.equal(state.metrics.cost.complete, false);
      assert.ok(state.metrics.durationMs.value > 0); await assert.rejects(access(join(state.environmentId, "workspace"))); assert.equal(await readFile(join(state.evaluationTarget.workspacePath, "result.txt"), "utf8"), "completed\n");
      assert.deepEqual(state.phases.map(value => value.phase), ["prepare", "execute", "freeze", "evaluate", "cleanup"]);
    }
    assert.ok(report.variants.every(value => value.successRate === 1));
    const first = createEvalPlan(context.experiment); const second = createEvalPlan(context.experiment); assert.deepEqual(first.trials, second.trials);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("failed execution can pass task checks and explicit retry receives a new trial identity", async () => {
  const context = await setup("failed"); context.experiment.variants[0].execution.options = { mode: "fail" };
  try {
    const initial = await context.runner.run(context.experiment); assert.equal(initial.trials[0].executionStatus, "failed"); assert.equal(initial.trials[0].taskVerdict, "passed"); assert.equal(initial.variants[0].successRate, 0);
    const retry = await context.runner.retry("failed", initial.trials[0].trial.id); assert.equal(retry.trials.length, 2); assert.equal(retry.trials[1].trial.retryOf, initial.trials[0].trial.id); assert.notEqual(retry.trials[1].trial.id, initial.trials[0].trial.id);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("execution timeout confirms process termination before frozen result verification", async () => {
  const context = await setup("limited"); context.experiment.variants[0].execution.options = { mode: "hang" }; context.experiment.cases[0].limits.executionTimeoutMs = 800; context.experiment.cases[0].evaluateAfterLimit = true;
  try {
    const report = await context.runner.run(context.experiment); const state = report.trials[0]; assert.equal(state.executionStatus, "limited"); assert.equal(state.taskVerdict, "passed", JSON.stringify(state)); assert.ok(state.errors.some(value => value.code === "phase-timeout")); assert.equal(report.variants[0].successRate, 0); await assert.rejects(access(join(state.environmentId, "workspace")));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("preflight rejects malformed input and unavailable environment capabilities", async () => {
  const context = await setup("invalid");
  try {
    context.experiment.cases[0].input = [{ role: "invalid", content: [] }]; assert.throws(() => context.runner.validate(context.experiment), /Invalid case.input/);
    context.experiment.cases[0].input = [{ role: "user", content: [{ type: "text", text: "run" }] }]; context.experiment.cases[0].requiredCapabilities = { protectedEvaluationResources: true }; assert.throws(() => context.runner.validate(context.experiment), /does not provide/);
    await assert.rejects(access(join(context.directory, "store", "invalid", "plan.json")));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("run budget duration and cancellation stop real executions", async () => {
  const limited = await setup("budget-time"); limited.experiment.variants[0].execution.options = { mode: "hang" }; limited.experiment.cases[0].limits.runBudget = { maxDurationMs: 700 };
  const cancelled = await setup("cancelled"); cancelled.experiment.variants[0].execution.options = { mode: "hang" };
  const controller = new AbortController(); const runner = new EvalRunner({ registry: cancelled.registry, store: cancelled.store, signal: controller.signal });
  try {
    const report = await limited.runner.run(limited.experiment); assert.equal(report.trials[0].executionStatus, "limited"); assert.ok(report.trials[0].metrics.durationMs.value < 3_000);
    const running = runner.run(cancelled.experiment); await waitFor(async () => { const state = await cancelled.store.readTrial("cancelled", "trial-1"); if (state?.environmentId === undefined) return false; try { await access(join(state.environmentId, "workspace", "process.json")); return true; } catch (error) { if (error.code !== "ENOENT") throw error; return false; } }); controller.abort(new Error("User cancelled evaluation"));
    const result = await running; assert.equal(result.trials[0].executionStatus, "cancelled"); assert.equal(result.trials[0].taskVerdict, "not-evaluated"); await assert.rejects(access(join(result.trials[0].environmentId, "workspace")));
  } finally { controller.abort(); await rm(limited.directory, { recursive: true, force: true }); await rm(cancelled.directory, { recursive: true, force: true }); }
});
test("retained output and evidence share the registered redactor", async () => {
  const context = await setup("redacted"); context.experiment.variants[0].execution.options = { mode: "private-output" }; context.experiment.evidencePolicy = { maxItems: 64, maxItemBytes: 65_536, maxTrialBytes: 1_048_576, retainContent: true, redactorId: "project-text", redactorVersion: "1", redact: value => value.replaceAll("private-candidate-value", "[redacted]") };
  try {
    const report = await context.runner.run(context.experiment); assert.equal(report.trials[0].execution.output.stdout, "[redacted]");
    const stored = await readFile(join(context.directory, "store", "redacted", "trials", "trial-1.json"), "utf8"); assert.ok(!stored.includes("private-candidate-value"));
    for (const reference of report.trials[0].evidence) assert.ok(!(await readFile(join(context.directory, "store", "redacted", reference.path), "utf8")).includes("private-candidate-value"));
    await assert.rejects(context.runner.resume("redacted"), /Restore the registered/); assert.equal((await context.runner.resume("redacted", context.experiment)).recorded, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("human review revisions and evaluator reruns preserve previous evidence", async () => {
  const context = await setup("review"); context.experiment.cases[0].evaluators = [{ id: "human", version: "1", required: true }, { id: "verify", version: "1", required: false }]; context.experiment.evidencePolicy = { maxItems: 64, maxItemBytes: 65_536, maxTrialBytes: 1_048_576, retainContent: true };
  try {
    const report = await context.runner.run(context.experiment); const trial = report.trials[0]; assert.equal(trial.awaitingReview, true); assert.equal(trial.taskVerdict, "inconclusive");
    const passed = await context.runner.grade("review", trial.trial.id, "human", { verdict: "passed", checks: [{ id: "content", verdict: "passed" }], evidence: [] }); assert.equal(passed.taskVerdict, "passed");
    const failed = await context.runner.grade("review", trial.trial.id, "human", { verdict: "failed", checks: [{ id: "content", verdict: "failed" }], evidence: [] }); assert.equal(failed.taskVerdict, "failed"); assert.equal(failed.evaluations.filter(value => value.evaluatorId === "human").length, 3);
    const checked = await context.runner.evaluateTrial("review", trial.trial.id, "verify"); assert.equal(checked.evaluations.filter(value => value.evaluatorId === "verify").length, 2); assert.equal(checked.evidence.length, trial.evidence.length + 1); assert.notEqual(checked.evidence[0].id, checked.evidence[1].id);
    for (const evidence of checked.evidence) { const content = await readFile(join(context.directory, "store", "review", evidence.path)); assert.equal(createHash("sha256").update(content).digest("hex"), evidence.sha256); }
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
test("resume preserves an interrupted execution until its host confirms termination", async () => {
  const context = await setup("interrupted"); context.experiment.variants[0].execution.options = { mode: "hang" };
  context.experiment.cases[0].evaluators = [{ id: "files", version: "1", required: true }]; context.experiment.cases[0].limits.executionTimeoutMs = 60_000;
  delete context.experiment.variants[0].execution.options;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./fixtures/interrupted-runner.mjs", import.meta.url)), context.directory, sourceDirectory], { stdio: ["ignore", "pipe", "pipe"] }); let errorOutput = ""; child.stderr.on("data", value => { errorOutput += value; }); let processId; let environmentId;
  try {
    await waitFor(async () => { const state = await context.store.readTrial("interrupted", "trial-1"); if (state?.environmentId === undefined) return false; environmentId = state.environmentId; try { processId = JSON.parse(await readFile(join(environmentId, "workspace", "process.json"), "utf8")).pid; return true; } catch (error) { if (error.code !== "ENOENT") throw error; return false; } });
    const ended = new Promise(resolvePromise => child.once("exit", resolvePromise)); child.kill(); await ended;
    const report = await context.runner.resume("interrupted"); assert.equal(report.trials[0].executionStatus, "interrupted"); assert.ok(report.trials[0].errors.some(value => value.code === "termination-unconfirmed")); assert.equal(report.recorded, 1); await access(join(environmentId, "workspace", "result.txt"));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); if (processId !== undefined) await new Promise(resolvePromise => treeKill(processId, "SIGKILL", () => resolvePromise())); await rm(context.directory, { recursive: true, force: true }); }
  assert.equal(errorOutput, "");
});
test("comparison validates source contents and applies only explicit regression gates", async () => {
  const context = await setup("compare"); const other = await setup("candidate"); other.experiment.variants[0].execution.options = { mode: "fail" };
  const different = await setup("different-source", {}, fileURLToPath(new URL("./fixtures/changed-input", import.meta.url)));
  try {
    const baseline = await context.runner.run(context.experiment); const candidate = await other.runner.run(other.experiment);
    assert.equal(compareEvalReports(baseline, candidate).passed, true); assert.equal(compareEvalReports(baseline, candidate, { allowedRegressedCases: [] }).passed, false);
    const changed = await different.runner.run(different.experiment);
    assert.equal(compareEvalReports(baseline, changed).compatible, false); assert.equal(compareEvalReports(baseline, candidate, { maxCostIncreaseRatio: 1 }).passed, false);
  } finally { await rm(context.directory, { recursive: true, force: true }); await rm(other.directory, { recursive: true, force: true }); await rm(different.directory, { recursive: true, force: true }); }
});
async function waitFor(condition) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolvePromise => setTimeout(resolvePromise, 25)); } throw new Error("Timed out waiting for the real process"); }
