import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalRunner, EvalRegistry, createLocalDirectoryEnvironment, createNodeCommandExecutionAdapter, createNodeCommandEvaluator,
  createJsonSchemaEvaluator, createFileChangesEvaluator, createCompositeEvaluator, createHumanEvaluator, readEvaluationFile } from "../dist/index.js";
import { FileEvalStore } from "../dist/file-store.js";

const workload = fileURLToPath(new URL("./fixtures/workload.mjs", import.meta.url));
async function setup(evaluators) {
  const parent = resolve("eval-verification", "evaluator-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "original.txt"), "unchanged");
  const registry = new EvalRegistry()
    .registerEnvironment(createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(root, "workspaces") }))
    .registerExecution(createNodeCommandExecutionAdapter({ id: "writer", version: "1", command: context => ({ script: workload, args: ["write"], cwd: context.target.workspacePath }) }));
  for (const evaluator of evaluators) registry.registerEvaluator(evaluator);
  const experiment = { id: "checks", seed: 11, repetitions: 1, concurrency: 1, evidencePolicy: { maxItemBytes: 65536, maxTrialBytes: 1048576, maxItems: 64, retainContent: true },
    cases: [{ id: "write", version: "1", description: "Write a valid result", input: [{ role: "user", content: [{ type: "text", text: "Write result.json" }] }],
      environment: { id: "local-directory", version: "1" }, evaluators: evaluators.map(item => ({ id: item.id, version: item.version, required: true })),
      limits: { prepareTimeoutMs: 5000, executionTimeoutMs: 5000, evaluationTimeoutMs: 5000, cleanupTimeoutMs: 5000, runBudget: { maxDurationMs: 5000 } } }],
    variants: [{ id: "writer", version: "1", configuration: {}, execution: { id: "writer", version: "1" } }] };
  const store = new FileEvalStore({ directory: join(root, "results") });
  const runner = new EvalRunner({ registry, store });
  return { runner, experiment, store };
}
const files = allowedPaths => createFileChangesEvaluator({ allowedPaths, requirements: [{ path: "result.json", equals: '{"answer":42}' }, { path: "original.txt", equals: "unchanged" }] });
const schema = answer => createJsonSchemaEvaluator({ schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { const: answer } } },
  read: async (context, signal) => JSON.parse(await readEvaluationFile(context.target.workspacePath, "result.json", signal)) });

test("real command, JSON Schema and file changes independently validate generated output", async () => {
  const { runner, experiment, store } = await setup([files(["result.json"]), schema(42), createNodeCommandEvaluator({ id: "command-check", version: "1",
    command: context => ({ script: workload, args: ["check"], cwd: context.target.workspacePath }) })]);
  const report = await runner.run(experiment);
  assert.equal(report.variants[0].successRate, 1);
  const [trial] = await store.listTrials("checks");
  assert.equal(trial.evaluations.length, 3);
  assert.ok(trial.evidence.every(reference => reference.path && reference.sha256.length === 64));
});

test("unexpected modified paths and failed JSON expectations are task failures", async () => {
  const { runner, experiment, store } = await setup([files([]), schema(43)]);
  await runner.run(experiment);
  const [trial] = await store.listTrials("checks");
  assert.equal(trial.executionStatus, "completed");
  assert.equal(trial.taskVerdict, "failed");
  assert.equal(trial.infrastructureStatus, "ready");
  assert.ok(trial.evaluations.every(value => value.result.verdict === "failed"));
});

test("composite results retain independent evidence and an optional failed check cannot reject a trial", async () => {
  const composite = createCompositeEvaluator({ id: "combined", version: "1", evaluators: [files(["result.json"]), schema(42)] });
  const optional = createJsonSchemaEvaluator({ id: "optional", schema: { type: "object", properties: { missing: { type: "string" } }, required: ["missing"] } });
  const { runner, experiment, store } = await setup([composite, optional]);
  experiment.cases[0].evaluators[1].required = false;
  await runner.run(experiment);
  const [trial] = await store.listTrials("checks");
  assert.equal(trial.taskVerdict, "passed");
  assert.equal(trial.evaluations[1].result.verdict, "failed");
});

test("human review retains original revision and appends independent confirmation", async () => {
  const { runner, experiment, store } = await setup([createHumanEvaluator()]);
  await runner.run(experiment);
  assert.equal((await store.listTrials("checks"))[0].awaitingReview, true);
  await runner.grade("checks", "trial-1", "human", { verdict: "passed", checks: [{ id: "human-result", verdict: "passed" }], evidence: [] });
  const [trial] = await store.listTrials("checks");
  assert.equal(trial.taskVerdict, "passed");
  assert.equal(trial.evaluations.length, 2);
  assert.equal(trial.evaluations[0].result.verdict, "awaiting-review");
});

test("repeated evaluation appends evidence and retains execution measurements", async () => {
  const { runner, experiment, store } = await setup([schema(42)]);
  await runner.run(experiment);
  const original = (await store.listTrials("checks"))[0];
  await runner.evaluateTrial("checks", "trial-1", "json-schema");
  const [reviewed] = await store.listTrials("checks");
  assert.equal(reviewed.taskVerdict, "passed");
  assert.deepEqual(reviewed.metrics, original.metrics);
  assert.equal(reviewed.evaluations.length, 2);
  assert.equal(reviewed.evidence.length, original.evidence.length + 1);
  assert.notEqual(reviewed.evidence[0].path, reviewed.evidence.at(-1).path);
  assert.equal(original.metrics.cost.amount, undefined);
  assert.equal(original.metrics.cost.complete, false);
  assert.equal(original.metrics.modelCalls.value, undefined);
});

test("file validation rejects changes to the retained evaluation snapshot", async () => {
  const { runner, experiment, store } = await setup([files(["result.json"])]);
  await runner.run(experiment);
  const original = (await store.listTrials("checks"))[0];
  await writeFile(join(original.evaluationTarget.workspacePath, "result.json"), '{"answer":43}');
  await assert.rejects(runner.evaluateTrial("checks", "trial-1", "file-changes"), /snapshot contents changed/);
  const [retained] = await store.listTrials("checks");
  assert.equal(retained.evaluations.length, 1);
  assert.deepEqual(retained.execution, original.execution);
});

test("concurrent writes respect the total retained evidence limit", async () => {
  const evaluator = { id: "parallel-evidence", version: "1", async evaluate(context, signal) {
    const content = await readEvaluationFile(context.target.workspacePath, "result.json", signal);
    const results = await Promise.allSettled(["first", "second"].map(id => context.evidenceSink.write({ id, mediaType: "application/json", content })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failed = results.find(result => result.status === "rejected");
    assert.ok(failed.reason instanceof RangeError);
    throw failed.reason;
  } };
  const { runner, experiment, store } = await setup([evaluator]);
  experiment.evidencePolicy.maxItems = 2;
  await runner.run(experiment);
  const [trial] = await store.listTrials("checks");
  assert.equal(trial.taskVerdict, "inconclusive");
  assert.equal(trial.evidence.length, 2);
  assert.ok(trial.errors.some(error => error.name === "RangeError"));
});

test("required execution isolation is rejected before starting a command", async () => {
  const { runner, experiment } = await setup([schema(42)]);
  experiment.cases[0].requiredCapabilities = { protectedEvaluationResources: true };
  await assert.rejects(runner.run(experiment), /protectedEvaluationResources/);
});
