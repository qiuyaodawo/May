import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvalRegistry,
  createNodeCommandEvaluator,
  createNodeCommandExecutionAdapter,
  createFileChangesEvaluator,
  createJsonSchemaEvaluator,
  createLocalDirectoryEnvironment,
} from "@may/eval";

const fixtureDirectory = fileURLToPath(new URL("./fixture", import.meta.url));
const writerPath = fileURLToPath(new URL("./write-artifact.mjs", import.meta.url));
const verifierPath = fileURLToPath(new URL("./verify-artifact.mjs", import.meta.url));
const id = process.env.MAY_EVAL_EXAMPLE_ID ?? "file-artifact";

export const registry = new EvalRegistry()
  .registerEnvironment(createLocalDirectoryEnvironment({
    id: "example-directory",
    version: "1",
    sourceDirectory: fixtureDirectory,
    rootDirectory: resolve(process.env.MAY_EVAL_EXAMPLE_WORKSPACE_ROOT ?? ".eval-workspaces"),
  }))
  .registerExecution(createNodeCommandExecutionAdapter({
    id: "artifact-command",
    version: "1",
    command: context => ({ script: writerPath, cwd: context.target.workspacePath }),
  }))
  .registerEvaluator(createNodeCommandEvaluator({
    id: "artifact-command-check",
    version: "1",
    command: context => ({ script: verifierPath, cwd: context.target.workspacePath }),
  }))
  .registerEvaluator(createJsonSchemaEvaluator({
    id: "artifact-schema",
    version: "1",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["message", "characters"],
      properties: { message: { const: "HELLO" }, characters: { const: 5 } },
    },
    read: async context => JSON.parse(await readFile(resolve(context.target.workspacePath, "result.json"), "utf8")),
  }))
  .registerEvaluator(createFileChangesEvaluator({
    id: "artifact-files",
    version: "1",
    allowedPaths: ["result.json"],
    requirements: [{ path: "result.json", exists: true, includes: '"message":"HELLO"' }],
  }));

export const experiment = {
  id,
  cases: [{
    id: "uppercase-artifact",
    version: "1",
    description: "Read input.json and create result.json with uppercase message and character count.",
    input: [{ role: "user", content: [{ type: "text", text: "Create the required result.json artifact." }] }],
    environment: { id: "example-directory", version: "1" },
    evaluators: [
      { id: "artifact-command-check", version: "1", required: true },
      { id: "artifact-schema", version: "1", required: true },
      { id: "artifact-files", version: "1", required: true },
    ],
    limits: {
      prepareTimeoutMs: 10_000,
      executionTimeoutMs: 10_000,
      evaluationTimeoutMs: 10_000,
      cleanupTimeoutMs: 10_000,
      runBudget: { maxDurationMs: 10_000 },
    },
  }],
  variants: [{
    id: "command",
    version: "1",
    execution: { id: "artifact-command", version: "1" },
    configuration: { commandVersion: "1", inputVersion: "1" },
  }],
  repetitions: 2,
  concurrency: 2,
  seed: 42,
  evidencePolicy: { maxItemBytes: 65_536, maxTrialBytes: 262_144, maxItems: 16, retainContent: true },
};
