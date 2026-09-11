import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTeamPreset, loadTeamPlan, parseTeamPlan } from "../dist/team-plan.js";

test("team presets share one runtime plan while keeping delegation and write authority explicit", () => {
  const supervisor = createTeamPreset("supervisor", "Inspect README.md", { model: "review-model" });
  const parallel = createTeamPreset("parallel", "Inspect README.md");
  const pipeline = createTeamPreset("pipeline", "Inspect README.md");
  assert.deepEqual(supervisor.roles.supervisor.delegateTo, ["worker"]);
  assert.deepEqual(parallel.roles.supervisor.delegateTo, []);
  assert.deepEqual(pipeline.roles.supervisor.delegateTo, []);
  assert.deepEqual(parallel.tasks[1].dependsOn, []);
  assert.deepEqual(pipeline.tasks[1].dependsOn, ["analysis"]);
  assert.equal(supervisor.roles.worker.model, "review-model");
  assert.ok(supervisor.roles.worker.tools.includes("submit_report"));
  assert.ok(!supervisor.roles.worker.tools.includes("write"));
  assert.ok(Object.isFrozen(supervisor.roles.worker.tools));
  const coding = createTeamPreset("pipeline", "Implement the requested fix", { mode: "coding" });
  assert.ok(coding.roles.worker.tools.includes("write"));
  assert.ok(!coding.roles.supervisor.tools.includes("write"));
  assert.throws(() => parseTeamPlan(coding), /requires --mode coding/u);
  assert.deepEqual(parseTeamPlan(coding, { mode: "coding" }), coding);
});

test("custom plans validate the entire graph and permissions, and loading snapshots bounded JSON", async (t) => {
  const valid = () => ({ format: 1, roles: { inspect: {}, final: { tools: ["read", "submit_report"] } },
    tasks: [{ id: "scan", agent: "inspect", input: "Inspect source" }, { id: "result", agent: "final", input: "Summarize", dependsOn: ["scan"] }],
    resultTaskId: "result", checks: [{ id: "contains", taskId: "scan", type: "file-contains", path: "README.md", text: "fixture" }] });
  const plan = parseTeamPlan(valid());
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.equal(plan.roles.inspect.messaging, false);
  assert.deepEqual(plan.roles.inspect.delegateTo, []);
  for (const mutate of [
    (value) => { value.mode = "coding"; },
    (value) => { value.roles.inspect.tools = ["shell"]; },
    (value) => { value.roles.inspect.tools = ["read", "read"]; },
    (value) => { value.roles.inspect.delegateTo = ["unknown"]; },
    (value) => { value.roles.inspect.runBudget = { maxModelCalls: 0 }; },
    (value) => { value.roles.inspect.runBudget = { maxCostUsd: 1 }; },
    (value) => { value.tasks[0].input = "x".repeat(65537); },
    (value) => { value.tasks[0].agent = "unknown"; },
    (value) => { value.tasks[0].dependsOn = ["result"]; },
    (value) => { value.tasks[1].dependsOn = ["missing"]; },
    (value) => { value.tasks[1].dependsOn = ["scan", "scan"]; },
    (value) => { value.tasks[1].id = "scan"; },
    (value) => { value.resultTaskId = "missing"; },
    (value) => { value.limits = { maxTasks: 1 }; },
    (value) => { value.limits = { maxConcurrent: 9 }; },
    (value) => { value.limits = { maxRetries: 4 }; },
    (value) => { value.checks[0].taskId = "missing"; },
  ]) { const value = valid(); mutate(value); assert.throws(() => parseTeamPlan(value)); }
  const directory = await mkdtemp(join(tmpdir(), "may-team-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plan.json");
  await writeFile(path, `\uFEFF${JSON.stringify(valid())}`);
  assert.deepEqual(await loadTeamPlan(path), plan);
  await writeFile(path, "{");
  await assert.rejects(loadTeamPlan(path), /valid UTF-8 JSON/u);
  await writeFile(path, " ".repeat(1_048_577));
  await assert.rejects(loadTeamPlan(path), /at most 1 MiB/u);
  assert.equal(plan.tasks[0].input, "Inspect source", "loaded plans do not depend on future file contents");
});
