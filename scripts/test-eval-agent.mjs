import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAgent } from "../packages/application/dist/index.js";
import { InMemoryContext } from "../packages/core/dist/index.js";
import { loadMayConfig } from "../packages/config/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent, parallelTasks } from "../packages/coordination/dist/index.js";
import { createBuiltinProviderAdapterRegistry, selectProviderModel } from "../packages/providers/dist/index.js";
import { FileSessionStore } from "../packages/session/dist/file-store.js";
import { createApplicationExecutionAdapter } from "../packages/eval/dist/application.js";
import { createCoordinationExecutionAdapter } from "../packages/eval/dist/coordination.js";
import { EvalRunner, EvalRegistry, createLocalDirectoryEnvironment, createFileChangesEvaluator, createJsonSchemaEvaluator, createModelEvaluator } from "../packages/eval/dist/index.js";
import { FileEvalStore } from "../packages/eval/dist/file-store.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = join(repository, "eval-verification", "live");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const source = join(directory, "source");
await mkdir(source);
await writeFile(join(source, "numbers.json"), JSON.stringify([2, 3, 5]));
const selection = selectProviderModel(await loadMayConfig());
const providerRegistry = createBuiltinProviderAdapterRegistry();
const model = () => providerRegistry.create(selection);
const sessionStore = new FileSessionStore(join(directory, "sessions"));
const versions = { component: "live-1", prompt: "numbers-1" };
const deniedPermissionChecks = new Map();
const deniedToolPlans = new Map();
const runBudget = { maxDurationMs: 90_000, maxModelCalls: 4, maxSteps: 4, maxToolCalls: 2 };
const prompt = "读取任务给出的数字，计算这些数字的总和与数量，然后调用 write_result 保存结果。数字为 [2,3,5]。保存后回复任务完成。";
const writeTool = workspacePath => ({
  name: "write_result", description: "把数字的总和与数量保存到 result.json。",
  inputSchema: { type: "object", properties: { sum: { type: "integer" }, count: { type: "integer" } }, required: ["sum", "count"], additionalProperties: false },
  async execute(input) {
    assert.equal(typeof input.sum, "number");
    assert.equal(typeof input.count, "number");
    await writeFile(join(workspacePath, "result.json"), JSON.stringify(input));
    return { saved: "result.json" };
  },
});
const registry = new EvalRegistry();
registry.registerEnvironment(createLocalDirectoryEnvironment({ version: versions.component, sourceDirectory: source, rootDirectory: join(directory, "environments") }));
registry.registerExecution(createApplicationExecutionAdapter({
  version: versions.component,
  approvals: { decide: () => "allow" },
  async open({ context, tracer, budget }) {
    return defineAgent({ model: budget.wrapModel(model()), tracer, tools: budget.wrapTools([writeTool(context.target.workspacePath)]), instructions: prompt,
      permissionPolicy: () => "ask", runBudget }).open({ store: sessionStore });
  },
}));
registry.registerExecution(createCoordinationExecutionAdapter({
  version: versions.component, outputTaskId: "save", approvals: { decide: () => "allow" },
  async create({ context, tracer, budget }) {
    const agents = {
      arithmetic: createApplicationAgent({ version: versions.component, store: sessionStore,
        definition: defineAgent({ model: budget.wrapModel(model()), tracer, instructions: "根据任务计算数字；只回复计算结果。", permissionPolicy: () => "deny", runBudget }) }),
      writer: createApplicationAgent({ version: versions.component, store: sessionStore,
        definition: defineAgent({ model: budget.wrapModel(model()), tracer, instructions: "使用依赖任务提供的总和与数量，调用 write_result 保存结果，然后回复任务完成。",
          tools: budget.wrapTools([writeTool(context.target.workspacePath)]), permissionPolicy: () => "ask", runBudget }) }),
    };
    return CoordinationRuntime.create({ id: context.trial.id, store: new InMemoryCoordinationStore(), agents,
      policy: { version: versions.component, authorize: () => true }, tracer,
      tasks: parallelTasks([
        { id: "sum", agent: "arithmetic", input: "计算 [2,3,5] 的总和。" },
        { id: "count", agent: "arithmetic", input: "计算 [2,3,5] 的数量。" },
      ], { id: "save", agent: "writer", input: prompt, files: ["result.json"] }),
      limits: { maxConcurrent: 2, maxTasks: 3, maxDurationMs: 120_000, runBudget: context.runBudget },
    });
  },
}));
registry.registerEvaluator(createFileChangesEvaluator({ version: versions.component, allowedPaths: ["result.json"], requirements: [{ path: "result.json", exists: true }] }));
registry.registerEvaluator(createJsonSchemaEvaluator({ version: versions.component,
  schema: { type: "object", properties: { sum: { const: 10 }, count: { const: 3 } }, required: ["sum", "count"], additionalProperties: false },
  async read(context, signal) { signal.throwIfAborted(); return JSON.parse(await readFile(join(context.target.workspacePath, "result.json"), "utf8")); },
}));
registry.registerEvaluator(createModelEvaluator({ version: versions.component, modelId: `${selection.adapter}:${selection.model}`,
  promptVersion: versions.prompt, model: model(), runBudget: { maxDurationMs: 60_000, maxSteps: 1, maxModelCalls: 1 },
  scoreThresholds: { correctness: 1 },
  rules: "检查保存的 JSON 是否包含 sum=10、count=3。两项都满足则 passed；任何一项不满足则 failed。checks 应包含 sum 和 count 两项。两项全部满足时 scores.correctness 为 1，否则为 0。",
  async input(context) { return { savedResult: JSON.parse(await readFile(join(context.target.workspacePath, "result.json"), "utf8")) }; },
}));
const experiment = {
  id: `live-${Date.now()}`, repetitions: 1, concurrency: 2, seed: 42,
  cases: [{ id: "numbers", version: "1", description: prompt, input: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    environment: { id: "local-directory", version: versions.component },
    evaluators: [{ id: "file-changes", version: versions.component, required: true }, { id: "json-schema", version: versions.component, required: true },
      { id: "model", version: versions.component, required: false }],
    limits: { prepareTimeoutMs: 10_000, executionTimeoutMs: 150_000, evaluationTimeoutMs: 90_000, cleanupTimeoutMs: 10_000, runBudget },
  }],
  variants: [{ id: "single", version: "1", execution: { id: "application", version: versions.component }, configuration: { model: selection.model, promptVersion: versions.prompt } },
    { id: "multi", version: "1", execution: { id: "coordination", version: versions.component }, configuration: { model: selection.model, promptVersion: versions.prompt } }],
  evidencePolicy: { retainContent: true, maxItemBytes: 1_048_576, maxTrialBytes: 8_388_608, maxItems: 128 },
};
const store = new FileEvalStore({ directory: join(directory, "results") });
console.log(JSON.stringify({ phase: "eval-start", profile: selection.profile, model: selection.model, adapter: selection.adapter, directory }));
await new EvalRunner({ registry, store }).run(experiment);
const trials = await store.listTrials(experiment.id);
assert.equal(trials.length, 2);
for (const trial of trials) {
  assert.equal(trial.executionStatus, "completed", JSON.stringify(trial.errors));
  assert.equal(trial.taskVerdict, "passed", JSON.stringify(trial.evaluations));
  assert.equal(trial.infrastructureStatus, "ready", JSON.stringify(trial.errors));
  assert.equal(trial.execution.terminationConfirmed, true);
  assert.ok(trial.metrics.modelCalls.value > 0);
  assert.ok(trial.metrics.modelAttempts.value >= trial.metrics.modelCalls.value);
  assert.ok(trial.metrics.toolCalls.value >= 1);
  assert.ok(trial.metrics.approvalWaitMs.value >= 0);
  assert.equal(trial.metrics.humanInterventions.value, 0);
  assert.equal(trial.metrics.totalTokens.complete, true);
  assert.ok(trial.metrics.totalTokens.value > 0);
  const grade = trial.evaluations.find(item => item.evaluatorId === "model");
  assert.equal(grade.result.verdict, "passed", JSON.stringify(grade));
  assert.equal(grade.result.checks.find(check => check.id === "score-threshold:correctness").verdict, "passed");
  assert.equal(trial.graderMetrics.modelCalls.value, 1);
  assert.ok(trial.graderMetrics.totalTokens.value > 0);
}
const single = trials.find(trial => trial.trial.variantId === "single");
const multi = trials.find(trial => trial.trial.variantId === "multi");
assert.equal(single.execution.identities.sessionIds.length, 1);
assert.equal(multi.execution.identities.sessionIds.length, 3);
assert.equal(multi.execution.identities.coordinationIds.length, 1);
const report = { completedAt: new Date().toISOString(), profile: selection.profile, model: selection.model,
  adapter: selection.adapter, experimentId: experiment.id, trials: trials.map(trial => ({ trialId: trial.trial.id,
    variantId: trial.trial.variantId, executionStatus: trial.executionStatus, taskVerdict: trial.taskVerdict,
    metrics: trial.metrics, graderMetrics: trial.graderMetrics, identities: trial.execution.identities })) };
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase: "eval-verified", report: join(directory, "report.json"), trials: trials.length }));

registry.registerExecution(createApplicationExecutionAdapter({
  id: "application-chat", version: versions.component,
  async open({ tracer, budget }) {
    return defineAgent({ model: budget.wrapModel(model()), tracer, tools: budget.wrapTools([]), permissionPolicy: () => "deny",
      instructions: "按用户要求简短回答。", runBudget }).open({ store: sessionStore });
  },
}));
registry.registerExecution(createApplicationExecutionAdapter({
  id: "application-no-approval", version: versions.component,
  async open({ context, tracer, budget }) {
    return defineAgent({ model: budget.wrapModel(model()), tracer, tools: budget.wrapTools([writeTool(context.target.workspacePath)]), instructions: prompt,
      permissionPolicy: () => "ask", runBudget }).open({ store: sessionStore });
  },
}));
registry.registerExecution(createApplicationExecutionAdapter({
  id: "application-no-tracer", version: versions.component, approvals: { decide: () => "allow" },
  async open({ context, budget }) {
    return defineAgent({ model: budget.wrapModel(model()), tools: budget.wrapTools([writeTool(context.target.workspacePath)]), instructions: prompt,
      permissionPolicy: () => "ask", runBudget }).open({ store: sessionStore });
  },
}));
registry.registerExecution(createApplicationExecutionAdapter({
  id: "application-denied", version: versions.component,
  async open({ context, tracer, budget }) {
    deniedPermissionChecks.set(context.trial.id, 0);
    const plans = [];
    deniedToolPlans.set(context.trial.id, plans);
    const provider = model();
    const observedModel = {
      get limits() { return provider.limits; }, get configuration() { return provider.configuration; },
      get capabilityVersion() { return provider.capabilityVersion; }, get reportsAttempts() { return provider.reportsAttempts; },
      get contextCompactor() { return provider.contextCompactor; },
      preflight: (request, options) => provider.preflight?.(request, options),
      async *stream(request, options) {
        for await (const event of provider.stream(request, options)) {
          if (event.type === "response.completed" && (event.message.toolCalls?.length ?? 0) > 0) {
            plans.push({ runId: options.runId, step: options.step,
              calls: event.message.toolCalls.map(call => ({ id: call.id, name: call.name, input: call.input })) });
          }
          yield event;
        }
      },
    };
    return defineAgent({ model: budget.wrapModel(observedModel), tracer, tools: budget.wrapTools([writeTool(context.target.workspacePath)]),
      instructions: "计算当前用户任务给出的数字总和与数量，调用 write_result 一次保存结果。工具权限拒绝后，只回复权限拒绝，并结束当前任务。",
      contextFactory: {
        create(options) {
          let activeRunId;
          let current = new InMemoryContext({ messages: [...(options.messages ?? [])], metadata: options.metadata });
          return { context: {
            async append(messages, appendOptions) {
              if (appendOptions?.runId !== undefined && appendOptions.runId !== activeRunId) {
                activeRunId = appendOptions.runId;
                current = new InMemoryContext({ metadata: options.metadata });
              }
              await current.append(messages);
            },
            async snapshot(snapshotOptions) {
              return { ...await current.snapshot(snapshotOptions), instructions: options.instructionsSource?.() ?? options.instructions };
            },
          } };
        },
      },
      permissionPolicy: () => { deniedPermissionChecks.set(context.trial.id, deniedPermissionChecks.get(context.trial.id) + 1); return "deny"; },
      runBudget }).open({ store: sessionStore });
  },
}));
const edgeReports = [];
for (const edge of [
  { id: "multi-budget", execution: "coordination", maxModelCalls: 2, expectedStatus: "limited", expectedAttempts: 2 },
  { id: "input-budget", execution: "application-chat", maxModelCalls: 1, expectedStatus: "limited", expectedAttempts: 1,
    input: [{ role: "user", content: [{ type: "text", text: "只回复第一轮完成。" }] }, { role: "user", content: [{ type: "text", text: "只回复第二轮完成。" }] }] },
  { id: "missing-approval", execution: "application-no-approval", expectedStatus: "failed", expectedReason: "interaction-unavailable" },
  { id: "execution-timeout", execution: "application", executionTimeoutMs: 25, expectedStatus: "limited" },
  { id: "missing-instrumentation", execution: "application-no-tracer", expectedStatus: "failed", expectedReason: "EVAL_BUDGET_INSTRUMENTATION_INCOMPLETE" },
  { id: "denied-tool-budget", execution: "application-denied", maxToolCalls: 1, expectedStatus: "limited", expectedReason: "RUN_BUDGET_EXCEEDED",
    input: [{ role: "user", content: [{ type: "text", text: "计算 [2,3,5] 的总和与数量，调用 write_result 保存结果。" }] },
      { role: "user", content: [{ type: "text", text: "计算 [7,11] 的总和与数量，调用 write_result 保存结果。" }] }] },
]) {
  const edgeExperiment = structuredClone(experiment);
  edgeExperiment.id = `${edge.id}-${Date.now()}`;
  edgeExperiment.concurrency = 1;
  edgeExperiment.cases[0].input = edge.input ?? edgeExperiment.cases[0].input;
  if (edge.executionTimeoutMs !== undefined) edgeExperiment.cases[0].limits.executionTimeoutMs = edge.executionTimeoutMs;
  edgeExperiment.variants = [{ id: edge.id, version: "1", execution: { id: edge.execution, version: versions.component }, configuration: { model: selection.model, promptVersion: versions.prompt },
    ...(edge.maxModelCalls === undefined && edge.maxToolCalls === undefined ? {} : { runBudget: {
      ...(edge.maxModelCalls === undefined ? {} : { maxModelCalls: edge.maxModelCalls }), ...(edge.maxToolCalls === undefined ? {} : { maxToolCalls: edge.maxToolCalls }),
    } }) }];
  await new EvalRunner({ registry, store }).run(edgeExperiment);
  const [trial] = await store.listTrials(edgeExperiment.id);
  assert.equal(trial.executionStatus, edge.expectedStatus, JSON.stringify(trial));
  assert.ok(!trial.errors.some(error => error.code === "termination-unconfirmed"), JSON.stringify(trial.errors));
  if (edge.expectedAttempts !== undefined) assert.equal(trial.metrics.modelAttempts.value, edge.expectedAttempts, JSON.stringify(trial.metrics));
  if (edge.expectedReason !== undefined) assert.equal(trial.execution.reason, edge.expectedReason);
  if (edge.id === "denied-tool-budget") {
    assert.equal(deniedPermissionChecks.get(trial.trial.id), 1);
    assert.equal(trial.metrics.toolCalls.value, 1);
    const history = await sessionStore.read(trial.execution.identities.sessionIds[0]);
    assert.equal(history.filter(event => event.type === "input.submitted").length, 2);
    const plans = deniedToolPlans.get(trial.trial.id);
    assert.equal(plans.length, 2, JSON.stringify(plans));
    assert.equal(new Set(plans.map(plan => plan.runId)).size, 2);
    assert.deepEqual(plans.map(plan => plan.calls.map(call => call.name)), [["write_result"], ["write_result"]]);
    assert.deepEqual(plans.map(plan => plan.calls[0].input), [{ sum: 10, count: 3 }, { sum: 18, count: 2 }]);
    await writeFile(join(directory, "denied-tool-plans.json"), JSON.stringify({ trialId: trial.trial.id,
      permissionChecks: deniedPermissionChecks.get(trial.trial.id), plans }, null, 2));
  }
  edgeReports.push({ id: edge.id, experimentId: edgeExperiment.id, executionStatus: trial.executionStatus,
    taskVerdict: trial.taskVerdict, metrics: trial.metrics, errors: trial.errors });
}
await writeFile(join(directory, "edge-report.json"), JSON.stringify(edgeReports, null, 2));
console.log(JSON.stringify({ phase: "eval-edge-verified", report: join(directory, "edge-report.json"), trials: edgeReports.length }));
