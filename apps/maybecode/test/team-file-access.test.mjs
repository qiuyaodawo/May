import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMayConfig } from "@sortedyuan/config";
import { FileCoordinationStore } from "@sortedyuan/coordination/file-store";
import { limits } from "../../../packages/coordination/dist/validation.js";
import { runMaybeCodeTeamCommand } from "../dist/team.js";
import { selectMaybeCodeModel } from "../dist/model.js";
import { parseTeamPlan } from "../dist/team-plan.js";
import { teamReviewDigest } from "../dist/team-recovery.js";

const workerPath = new URL("./fixtures/team-file-access-worker.mjs", import.meta.url);
const fixtureRoot = fileURLToPath(new URL("../../../review/migration/team-file-tests/", import.meta.url));

async function fixture(t, version, { writeManifest = true } = {}) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, "team-"));
  const child = relative(resolve(fixtureRoot), resolve(root));
  assert.ok(!isAbsolute(child) && !child.startsWith("..") && child.startsWith("team-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "source"), dataDirectory = join(root, "data"), id = randomUUID();
  const directory = join(dataDirectory, "teams", id), configPath = join(root, "config.json");
  await mkdir(workspace);
  await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, "README.md"), "Stored team command verification.\n");
  await writeFile(configPath, JSON.stringify({ providers: { local: { adapter: "openai-responses", baseURL: "http://127.0.0.1:1/v1", apiKey: "unused-local-credential" } },
    models: { configured: { provider: "local", model: "configured" } }, defaultModel: "configured" }));
  const selected = selectMaybeCodeModel(await loadMayConfig({ path: configPath }));
  const routing = { profile: selected.profile, provider: selected.provider, adapter: selected.adapter,
    model: selected.model, options: selected.options, baseURL: selected.providerConfig.baseURL, limits: selected.limits };
  const plan = parseTeamPlan({ format: 1, roles: { reader: { tools: ["read"] } },
    tasks: [{ id: "read-source", agent: "reader", input: "Read README.md" }], resultTaskId: "read-source" });
  const manifest = { format: 1, version: `maybecode-team-${version}`, id, createdAt: new Date().toISOString(), workspace,
    configPath, model: "configured", prompt: "Read README.md", maxModelCalls: 1, maxTotalTokens: 32768, maxConcurrent: 1,
    ...(version === "v1" ? { modelFingerprint: createHash("sha256").update(JSON.stringify(routing)).digest("hex") }
      : { mode: "read-only", allowChecks: false, plan,
        roleModels: { reader: { profile: "configured", fingerprint: teamReviewDigest(routing), runBudget: {} } } }) };
  if (writeManifest) await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  const policyVersion = version === "v1" ? "maybecode-team-v1"
    : `maybecode-team-v2-${teamReviewDigest({ mode: manifest.mode, allowChecks: manifest.allowChecks, plan, roleModels: manifest.roleModels })}`;
  const journal = await new FileCoordinationStore(join(directory, "coordination")).acquire(id);
  try {
    await journal.commit({ format: 1, id, revision: 1, policyVersion, limits: limits(), commands: {},
      tasks: [{ ...(version === "v1" ? { id: "summary", agent: "supervisor", input: "Read README.md", dependsOn: [] } : plan.tasks[0]),
        agentVersion: policyVersion, dispatchId: randomUUID(), sessionId: randomUUID(), status: "cancelled", turn: 0 }] }, 0);
  } finally { await journal.close(); }
  if (version === "v1") await writeFile(join(directory, "status.txt"), "Revision 1\nsummary: cancelled\n");
  const command = action => ({ type: "team", action, value: id, dataDirectory });
  return { id, directory, manifest, command };
}

async function startWorker(t, job) {
  const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "", failure, closed = false;
  const queued = [], pending = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr += text; });
  const completed = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code, signal) => {
      closed = true;
      if (code === 0) resolveCompletion();
      else rejectCompletion(new Error(`Team worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  void completed.catch(error => { failure = error; for (const waiter of pending.splice(0)) waiter.reject(error); });
  child.on("message", message => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  const next = async type => {
    if (failure) throw failure;
    const message = queued.length ? queued.shift() : await new Promise((resolveMessage, reject) => pending.push({ resolve: resolveMessage, reject }));
    assert.equal(message.type, type);
  };
  t.after(async () => { if (!closed) child.kill(); await completed.catch(() => undefined); });
  child.send(job);
  await next("ready");
  child.send({ type: "start" });
  return { next, release: () => child.send({ type: "release" }), completed };
}

async function businessFiles(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith(".access") || entry.name.endsWith(".access.gate")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result[entry.name] = await businessFiles(path);
    else result[entry.name] = (await readFile(path)).toString("base64");
  }
  return result;
}

for (const version of ["v1", "v2"]) {
  test(`${version} team status readers coexist with command projection updates across processes`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, version);
    const action = version === "v1" ? "resume" : "verify";
    assert.equal(await runMaybeCodeTeamCommand(f.command(action), { write() {} }), 1);
    const readers = await Promise.all(Array.from({ length: 2 }, () => startWorker(t,
      { kind: "command", command: f.command("status"), version, count: 80, exitCode: 0 })));
    await Promise.all(readers.map(reader => reader.next("started")));
    for (let index = 0; index < 30; index++) assert.equal(await runMaybeCodeTeamCommand(f.command(action), { write() {} }), 1);
    await Promise.all(readers.map(reader => reader.completed));
    const before = await businessFiles(f.directory);
    assert.equal(await runMaybeCodeTeamCommand(f.command("status"), { write() {} }), 0);
    assert.deepEqual(await businessFiles(f.directory), before);
  });

  test(`${version} team cancellation requests remain complete for concurrent readers`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, version);
    assert.equal(await runMaybeCodeTeamCommand(f.command("cancel"), { write() {} }), 0);
    const readers = await Promise.all(Array.from({ length: 2 }, () => startWorker(t,
      { kind: "read-cancellation", path: join(f.directory, "cancel.request.json"), id: f.id, count: 160 })));
    await Promise.all(readers.map(reader => reader.next("started")));
    for (let index = 0; index < 80; index++) assert.equal(await runMaybeCodeTeamCommand(f.command("cancel"), { write() {} }), 0);
    await Promise.all(readers.map(reader => reader.completed));
    assert.equal(JSON.parse(await readFile(join(f.directory, "cancel.request.json"), "utf8")).id, f.id);
  });
}

test("team status waits for an in-progress initial manifest write", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "v2", { writeManifest: false });
  const writer = await startWorker(t, { kind: "partial-manifest", path: join(f.directory, "manifest.json"), manifest: f.manifest });
  await writer.next("partial");
  const reader = await startWorker(t, { kind: "command", command: f.command("status"), version: "v2", initialManifest: true, count: 1, exitCode: 0 });
  await reader.next("started");
  writer.release();
  await Promise.all([writer.completed, reader.completed]);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8")), f.manifest);
});
