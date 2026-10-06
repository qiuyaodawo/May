import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const suite = fileURLToPath(new URL("../examples/suite.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const verificationRoot = resolve(repository, "eval-verification");
const workspaceRoot = join(verificationRoot, `cli-workspaces-${randomUUID()}`);

after(async () => {
  const child = relative(verificationRoot, workspaceRoot);
  assert.ok(child.length > 0 && !child.startsWith("..") && !isAbsolute(child));
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("built CLI validates, runs, reports, resumes and compares actual command tasks", { timeout: 60_000 }, async t => {
  const directory = await outputDirectory(t);
  assert.equal((await run(["validate", "--suite", suite], "cli-success")).code, 0);
  const execution = await run(["run", "--suite", suite, "--output", directory], "cli-success");
  assert.equal(execution.code, 0, execution.stderr);
  const experimentDirectory = join(directory, "cli-success");
  const report = JSON.parse(await readFile(join(experimentDirectory, "report.json"), "utf8"));
  assert.equal(report.planned, 2);
  assert.equal(report.variants[0].successful, 2);
  assert.equal(report.trials.every(trial => trial.execution.terminationConfirmed), true);
  assert.equal(report.trials.every(trial => trial.evaluations.length === 3), true);
  assert.equal(report.trials.every(trial => trial.metrics.cost.complete === false), true);
  assert.equal(report.trials.every(trial => trial.metrics.cost.amount === undefined), true);
  assert.equal((await run(["report", "--experiment", experimentDirectory])).code, 0);
  assert.equal((await run(["resume", "--suite", suite, "--experiment", experimentDirectory], "cli-success")).code, 0);
  const resumed = JSON.parse(await readFile(join(experimentDirectory, "report.json"), "utf8"));
  assert.deepEqual(resumed.trials, report.trials);
  assert.equal((await run(["compare", "--baseline", experimentDirectory, "--candidate", experimentDirectory])).code, 0);
  const comparison = JSON.parse(await readFile(join(experimentDirectory, "comparison.json"), "utf8"));
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.passed, true);
  const thresholds = join(directory, "thresholds.json");
  await writeFile(thresholds, JSON.stringify({ maxCostIncreaseRatio: 0 }));
  const incompleteCost = await run(["compare", "--baseline", experimentDirectory, "--candidate", experimentDirectory, "--thresholds", thresholds]);
  assert.equal(incompleteCost.code, 1);
  assert.match(incompleteCost.stdout, /Complete comparable cost measurements are unavailable/);
});

test("trial failures keep reports and return nonzero", { timeout: 30_000 }, async t => {
  const directory = await outputDirectory(t);
  const result = await run(["run", "--suite", join(fixtures, "failing-suite.mjs"), "--output", directory], "cli-failure");
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(await readFile(join(directory, "cli-failure", "report.json"), "utf8"));
  assert.equal(report.variants[0].successful, 0);
  assert.equal(report.trials[0].executionStatus, "failed");
  assert.equal(report.trials[0].execution.output.exitCode, 7);
  assert.equal(typeof await readFile(join(directory, "cli-failure", "report.md"), "utf8"), "string");
  const thresholds = join(directory, "success-threshold.json");
  await writeFile(thresholds, JSON.stringify({ minimumSuccessRate: 1, allowedRegressedCases: [] }));
  const gated = await run(["compare", "--baseline", join(directory, "cli-failure"), "--candidate", join(directory, "cli-failure"), "--thresholds", thresholds]);
  assert.equal(gated.code, 1);
  assert.match(gated.stdout, /Candidate success rate is below the configured minimum/);
});

test("unconfirmed generic command keeps its workspace and reports failure", { timeout: 30_000 }, async t => {
  const directory = await outputDirectory(t);
  const execution = await run(["run", "--suite", join(fixtures, "unconfirmed-suite.mjs"), "--output", directory], "cli-unconfirmed");
  assert.equal(execution.code, 1, execution.stderr);
  const report = JSON.parse(await readFile(join(directory, "cli-unconfirmed", "report.json"), "utf8"));
  const trial = report.trials[0];
  assert.equal(report.variants[0].successful, 0);
  assert.equal(trial.execution.terminationConfirmed, false);
  assert.ok(trial.errors.some(value => value.code === "termination-unconfirmed"));
  assert.equal(trial.evaluationTarget, undefined);
  await access(join(trial.environmentId, "workspace", "result.json"));
});

test("rejects changed acceptance versions and changed suites on resume", { timeout: 60_000 }, async t => {
  const directory = await outputDirectory(t);
  assert.equal((await run(["run", "--suite", suite, "--output", directory], "cli-baseline")).code, 0);
  assert.equal((await run(["run", "--suite", join(fixtures, "incompatible-suite.mjs"), "--output", directory], "cli-candidate")).code, 0);
  const baseline = join(directory, "cli-baseline");
  const candidate = join(directory, "cli-candidate");
  const comparison = await run(["compare", "--baseline", baseline, "--candidate", candidate]);
  assert.equal(comparison.code, 1);
  assert.match(comparison.stdout, /Case or environment or evaluator changed/);
  const resumed = await run(["resume", "--suite", join(fixtures, "incompatible-suite.mjs"), "--experiment", baseline], "cli-baseline");
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /Suite configuration differs/);
});

test("human grade appends revisions and refreshes report", { timeout: 30_000 }, async t => {
  const directory = await outputDirectory(t);
  const initial = await run(["run", "--suite", join(fixtures, "human-suite.mjs"), "--output", directory], "cli-human");
  assert.equal(initial.code, 1);
  const experiment = join(directory, "cli-human");
  const before = JSON.parse(await readFile(join(experiment, "report.json"), "utf8"));
  assert.equal(before.trials[0].awaitingReview, true);
  const result = join(directory, "grade.json");
  await writeFile(result, JSON.stringify({ verdict: "passed", checks: [{ id: "review", verdict: "passed" }], evidence: [] }));
  const graded = await run(["grade", "--experiment", experiment, "--trial", before.trials[0].trial.id, "--evaluator", "artifact-review", "--result", result]);
  assert.equal(graded.code, 0, graded.stderr);
  const after = JSON.parse(await readFile(join(experiment, "report.json"), "utf8"));
  assert.equal(after.trials[0].awaitingReview, false);
  assert.equal(after.variants[0].successful, 1);
  assert.equal(after.trials[0].evaluations.filter(value => value.evaluatorId === "artifact-review").length, 2);
  await writeFile(result, JSON.stringify({ verdict: "failed", checks: [{ id: "review", verdict: "failed" }], evidence: [] }));
  assert.equal((await run(["grade", "--experiment", experiment, "--trial", before.trials[0].trial.id, "--evaluator", "artifact-review", "--result", result])).code, 1);
  const revision = JSON.parse(await readFile(join(experiment, "report.json"), "utf8"));
  assert.equal(revision.trials[0].taskVerdict, "failed");
  assert.equal(revision.trials[0].evaluations.filter(value => value.evaluatorId === "artifact-review").length, 3);
});

test("manual grade restores a required suite redactor before persisting review text", { timeout: 30_000 }, async t => {
  const directory = await outputDirectory(t);
  const redactedSuite = join(fixtures, "redacted-human-suite.mjs");
  assert.equal((await run(["run", "--suite", redactedSuite, "--output", directory], "cli-redacted-review")).code, 1);
  const experiment = join(directory, "cli-redacted-review");
  const before = JSON.parse(await readFile(join(experiment, "report.json"), "utf8"));
  assert.equal(before.trials[0].awaitingReview, true);
  const result = join(directory, "review.json");
  await writeFile(result, JSON.stringify({ verdict: "passed", checks: [{ id: "review", verdict: "passed", message: "private-review-value" }], evidence: [] }));
  const args = ["grade", "--experiment", experiment, "--trial", before.trials[0].trial.id, "--evaluator", "artifact-review", "--result", result];
  const unavailable = await run(args);
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.stderr, /Restore the registered evidence redactor/);
  const graded = await run([...args, "--suite", redactedSuite], "cli-redacted-review");
  assert.equal(graded.code, 0, graded.stderr);
  assert.ok(!graded.stdout.includes("private-review-value"));
  const contents = await readFile(join(experiment, "report.json"), "utf8");
  assert.ok(!contents.includes("private-review-value"));
  const report = JSON.parse(contents);
  assert.equal(report.variants[0].successful, 1);
  assert.equal(report.trials[0].evaluations.at(-1).result.checks[0].message, "[redacted]");
});

async function outputDirectory(t) {
  await mkdir(verificationRoot, { recursive: true });
  const directory = await mkdtemp(join(verificationRoot, "cli-"));
  t.after(async () => {
    const child = relative(verificationRoot, directory);
    assert.ok(child.length > 0 && !child.startsWith("..") && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(args, experimentId) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: repository,
      env: { ...process.env, MAY_EVAL_EXAMPLE_WORKSPACE_ROOT: workspaceRoot, ...(experimentId === undefined ? {} : { MAY_EVAL_EXAMPLE_ID: experimentId }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.once("error", reject);
    child.once("close", code => resolveResult({ code, stdout, stderr }));
  });
}
