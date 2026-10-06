import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { PermissionToolExecutor } from "../../permissions/dist/index.js";
import { DiagnosticsStore } from "../../observability/dist/index.js";
import { EvalTrialBudget } from "../dist/agent-budget.js";
import { EvalTelemetryCollector, createEvalTaskAssessment, evalMetrics } from "../dist/telemetry.js";

const directory = resolve("../../eval-verification/adapter-tests");
await mkdir(directory, { recursive: true });

test("trial tool budget checks a real file writer before additional effects", async () => {
  const workspace = await mkdtemp(join(directory, "tool-budget-"));
  const telemetry = new EvalTelemetryCollector();
  const budget = new EvalTrialBudget({ maxToolCalls: 1 }, telemetry);
  const [tool] = budget.wrapTools([{
    name: "write", description: "保存文件", inputSchema: { type: "object" },
    async execute(input) { await writeFile(join(workspace, "result.txt"), input.text); return { saved: true }; },
  }]);
  budget.start();
  const context = { runId: "run", step: 1, toolCallId: "write-1", idempotencyKey: "write-1",
    signal: new AbortController().signal, report() {} };
  assert.deepEqual(await tool.execute({ text: "first" }, context), { saved: true });
  await assert.rejects(tool.execute({ text: "second" }, { ...context, toolCallId: "write-2" }), error => error.code === "RUN_BUDGET_EXCEEDED");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "first");
  assert.equal(budget.snapshot().toolCalls, 1);
});

test("collector observes real permission requests and bounded approval waiting", async () => {
  const workspace = await mkdtemp(join(directory, "approval-"));
  const collector = new EvalTelemetryCollector();
  const executor = new PermissionToolExecutor({ policy: () => "ask", tracer: collector.tracer });
  const relay = (async () => {
    for await (const event of executor.events) {
      collector.observe({ type: "permission.event", event }, "approval-session");
      if (event.type === "approval.requested") assert.equal(await executor.resolve(event.request.id, "allow"), true);
    }
  })();
  try {
    const result = await executor.execute({
      tool: { name: "save", description: "保存文件", inputSchema: { type: "object" },
        async execute() { await writeFile(join(workspace, "approved.txt"), "approved"); return "saved"; } },
      input: {}, context: { runId: "permission-run", step: 1, toolCallId: "save-1", idempotencyKey: "save-1",
        signal: new AbortController().signal, report() {} },
    });
    assert.equal(result, "saved");
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved");
  } finally { await executor.close(); await relay; }
  const metrics = evalMetrics(collector.metrics());
  assert.equal(metrics.approvalWaitMs.complete, true);
  assert.ok(metrics.approvalWaitMs.value >= 0);
  assert.equal(metrics.humanInterventions.value, 0);
  assert.equal(metrics.cost.complete, false);
  assert.equal(metrics.cost.amount, undefined);
  assert.equal(metrics.totalTokens.complete, false);
  assert.equal(metrics.totalTokens.value, undefined);
  assert.equal(collector.approvalEvidence().length, 1);
  assert.equal(collector.approvalEvidence()[0].decision, "allow");
  assert.equal(collector.approvalEvidence()[0].status, "resolved");
  assert.equal(Object.hasOwn(collector.approvalEvidence()[0], "input"), false);
  assert.ok(collector.evidence().every(span => Object.keys(span.attributes).every(key => !key.includes("input") || key.endsWith("input_tokens"))));
});

test("assessment keeps unique runtime correlation and avoids selecting one session in a team", () => {
  const diagnostics = new DiagnosticsStore();
  const assessment = createEvalTaskAssessment({ trialId: "trial", evaluatorId: "files", evaluatorVersion: "1", verdict: "passed",
    identities: { sessionIds: ["worker-one", "worker-two"], runIds: ["run-one", "run-two"],
      taskIds: ["task-one", "task-two"], coordinationIds: ["team"], traceIds: ["trace-one", "trace-two"] },
    evidenceReferences: ["result.json"], configurationVersion: "config-1", timestamp: Date.now(),
  });
  assert.equal(assessment.taskId, "trial");
  assert.equal(assessment.sessionId, undefined);
  assert.equal(assessment.runId, undefined);
  assert.equal(assessment.coordinationId, "team");
  diagnostics.recordAssessment(assessment);
  assert.deepEqual(diagnostics.getDiagnostics({ taskId: "trial", coordinationId: "team" }).assessments, [assessment]);
});

test("bounded telemetry declares incomplete measurements after its record limit", () => {
  const collector = new EvalTelemetryCollector({}, 1);
  collector.tracer.startSpan("first-operation").end();
  collector.tracer.startSpan("second-operation").end();
  assert.equal(collector.evidence().length, 1);
  const metrics = evalMetrics(collector.metrics());
  assert.equal(metrics.modelCalls.complete, false);
  assert.deepEqual(metrics.modelCalls.missingReasons, ["telemetry-entry-limit"]);
  assert.equal(metrics.cost.complete, false);
  assert.ok(metrics.cost.missingReasons.includes("telemetry-entry-limit"));
});
