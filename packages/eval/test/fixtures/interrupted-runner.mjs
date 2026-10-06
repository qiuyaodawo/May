import { join } from "node:path";
import { EvalRunner, EvalRegistry, createLocalDirectoryEnvironment, createNodeCommandExecutionAdapter, createFileChangesEvaluator } from "../../dist/index.js";
import { FileEvalStore } from "../../dist/file-store.js";
const [directory, sourceDirectory] = process.argv.slice(2);
const registry = new EvalRegistry()
  .registerEnvironment(createLocalDirectoryEnvironment({ sourceDirectory, rootDirectory: `${directory}/workspaces` }))
  .registerExecution(createNodeCommandExecutionAdapter({ id: "command", version: "1", command(context) { return { script: join(context.target.workspacePath, "action.mjs"), args: ["hang"], cwd: context.target.workspacePath }; } }))
  .registerEvaluator(createFileChangesEvaluator({ id: "files", allowedPaths: ["result.txt", "process.json"], requirements: [{ path: "result.txt", equals: "completed\n" }] }));
await new EvalRunner({ registry, store: new FileEvalStore({ directory: `${directory}/store` }) }).run({ id: "interrupted", repetitions: 1, concurrency: 1, seed: 1,
  cases: [{ id: "write-result", version: "1", description: "Write a result file", input: [{ role: "user", content: [{ type: "text", text: "Write a result file" }] }], environment: { id: "local-directory", version: "1" }, evaluators: [{ id: "files", version: "1", required: true }], limits: { prepareTimeoutMs: 5_000, executionTimeoutMs: 60_000, evaluationTimeoutMs: 5_000, cleanupTimeoutMs: 5_000, runBudget: {} } }], variants: [{ id: "external", version: "1", execution: { id: "command", version: "1" }, configuration: {} }] });
