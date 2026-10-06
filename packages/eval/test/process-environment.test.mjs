import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import treeKill from "tree-kill";
import { createLocalDirectoryEnvironment, readFileManifest, startEvalProcess, nodeEvalCommand, createCommandExecutionAdapter } from "../dist/index.js";

const parent = resolve("eval-verification", "environment-tests");
const workload = fileURLToPath(new URL("./fixtures/workload.mjs", import.meta.url));
async function setup() {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "initial.txt"), "original");
  const environment = createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(root, "environments") });
  return { root, source, environment };
}
function context(id) {
  return { trial: { id, experimentId: "environment-tests" }, options: {}, signal: new AbortController().signal };
}

test("independent workspaces and retained frozen evidence preserve source", async () => {
  const { source, environment } = await setup();
  const first = await environment.prepare(context("first"));
  const second = await environment.prepare(context("second"));
  assert.notEqual(first.executionTarget.workspacePath, second.executionTarget.workspacePath);
  assert.equal(first.capabilities.processIsolation, false);
  assert.equal(first.capabilities.protectedEvaluationResources, false);
  await writeFile(join(first.executionTarget.workspacePath, "initial.txt"), "edited");
  const frozen = await first.freeze(new AbortController().signal);
  assert.equal(await readFile(join(frozen.workspacePath, "initial.txt"), "utf8"), "edited");
  assert.equal(await readFile(join(source, "initial.txt"), "utf8"), "original");
  assert.equal(await readFile(join(second.executionTarget.workspacePath, "initial.txt"), "utf8"), "original");
  assert.notEqual(frozen.data.snapshotDigest, frozen.data.baselineDigest);
  await first.dispose(new AbortController().signal);
  await first.dispose(new AbortController().signal);
  await assert.rejects(access(first.executionTarget.workspacePath));
  await access(frozen.workspacePath);
  await second.dispose(new AbortController().signal);
});

test("snapshot limits, source overlap and recovery paths fail safely", async () => {
  const { root, source } = await setup();
  const limited = createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(root, "limited"), maxBytes: 1 });
  await assert.rejects(limited.prepare(context("limited")), /limit/);
  const overlapping = createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(source, "output") });
  await assert.rejects(overlapping.prepare(context("overlap")), /overlap/);
  const recovering = createLocalDirectoryEnvironment({ sourceDirectory: source, rootDirectory: join(root, "recovering") });
  const prepared = await recovering.prepare(context("interrupted"));
  await recovering.recover(context("interrupted"));
  await assert.rejects(access(prepared.executionTarget.workspacePath));
  assert.equal((await readFileManifest(source, new AbortController().signal)).length, 1);
});

test("real subprocess success, errors, bounded output and environment filtering", async () => {
  const { root } = await setup();
  const run = mode => startEvalProcess({ executable: process.execPath, args: [workload, mode], cwd: root, maxOutputBytes: 1024 }, new AbortController().signal).result;
  assert.equal((await run("write")).exitCode, 0);
  assert.equal((await run("check")).exitCode, 0);
  assert.notEqual((await run("fail")).exitCode, 0);
  const output = await run("output");
  assert.equal(output.truncated, true);
  assert.equal(output.stdout.length, 1024);
  assert.equal(output.stderr.length, 1024);
  process.env.EVAL_PRIVATE_CREDENTIAL = "test-scope-only";
  try { assert.equal(JSON.parse((await run("env")).stdout).credentialVisible, false); }
  finally { delete process.env.EVAL_PRIVATE_CREDENTIAL; }
  await assert.rejects(startEvalProcess({ executable: join(root, "missing-executable"), args: [], cwd: root }, new AbortController().signal).result);
  assert.throws(() => startEvalProcess({ executable: process.execPath, args: [workload, "write"] }, new AbortController().signal), /cwd/);
});

test("cancellation stops a real child process tree", async () => {
  const { root } = await setup();
  const controller = new AbortController();
  const running = startEvalProcess({ executable: process.execPath, args: [workload, "tree"], cwd: root }, controller.signal);
  await new Promise(accept => setTimeout(accept, 350));
  controller.abort();
  assert.equal(await running.cancel(), true);
  const result = await running.result;
  assert.equal(result.processTerminationConfirmed, true);
  const pids = JSON.parse(result.stdout.trim());
  for (const pid of [pids.parent, pids.child]) assert.throws(() => process.kill(pid, 0));
});

test("Node execution permissions refuse child processes and runtime overrides", async () => {
  const { root } = await setup();
  const command = nodeEvalCommand({ script: workload, args: ["tree"], cwd: root });
  const outcome = await startEvalProcess(command, new AbortController().signal).result;
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.stderr, /ERR_ACCESS_DENIED/);
  assert.equal(outcome.processTerminationConfirmed, true);
  assert.throws(() => nodeEvalCommand({ script: workload, cwd: root, env: { NODE_OPTIONS: "--allow-child-process" } }), /runtime options/);
});

test("a completed parent cannot confirm a detached child without host supervision", async () => {
  const { root } = await setup();
  const adapter = createCommandExecutionAdapter({ id: "unconfirmed", version: "1", command: context => ({ executable: process.execPath, args: [workload, "orphan"], cwd: context.target.workspacePath }) });
  const execution = await adapter.create({ target: { workspacePath: root }, signal: new AbortController().signal });
  const outcome = await execution.execute(new AbortController().signal);
  const { child } = JSON.parse(outcome.output.stdout);
  try {
    assert.equal(outcome.output.exitCode, 0);
    assert.equal(outcome.terminationConfirmed, false);
    process.kill(child, 0);
    assert.equal((await execution.cancel(new AbortController().signal)).confirmed, false);
    await assert.rejects(execution.close(new AbortController().signal), /termination/);
  } finally {
    await new Promise((accept, reject) => treeKill(child, "SIGKILL", error => error ? reject(error) : accept()));
  }
  assert.throws(() => process.kill(child, 0));
});
