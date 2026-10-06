import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EvalRegistry, EvalRunner, createLocalDirectoryEnvironment, createNodeCommandExecutionAdapter, createJsonSchemaEvaluator } from "@may/eval";
import { FileEvalStore } from "@may/eval/file-store";
import * as application from "@may/eval/application";
import * as coordination from "@may/eval/coordination";

assert.ok(Object.keys(application).length);
assert.ok(Object.keys(coordination).length);
const source = resolve("source");
await mkdir(source);
await writeFile(join(source, "work.mjs"), 'console.log("consumer-installation-ok");\n');
const registry = new EvalRegistry()
  .registerEnvironment(createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: resolve("workspaces") }))
  .registerExecution(createNodeCommandExecutionAdapter({ id: "command", version: "1", command: context => ({ script: join(context.target.workspacePath, "work.mjs"), cwd: context.target.workspacePath }) }))
  .registerEvaluator(createJsonSchemaEvaluator({ schema: { type: "object", required: ["exitCode"], properties: { exitCode: { const: 0 } } } }));
const store = new FileEvalStore({ directory: resolve("results") });
const experiment = { id: "consumer", seed: 5, repetitions: 1, concurrency: 1, cases: [{ id: "execution", version: "1", description: "Execute installed package",
  input: [{ role: "user", content: [{ type: "text", text: "Run the prepared program" }] }], environment: { id: "local-directory", version: "1" },
  evaluators: [{ id: "json-schema", version: "1", required: true }],
  limits: { prepareTimeoutMs: 10000, executionTimeoutMs: 10000, evaluationTimeoutMs: 10000, cleanupTimeoutMs: 10000, runBudget: { maxDurationMs: 10000 } } }],
  variants: [{ id: "command", version: "1", configuration: {}, execution: { id: "command", version: "1" } }] };
await new EvalRunner({ registry, store }).run(experiment);
const trials = await store.listTrials("consumer");
assert.equal(trials[0].executionStatus, "completed");
assert.equal(trials[0].taskVerdict, "passed");
console.log("Installed Eval root and adapter subpaths executed successfully");
