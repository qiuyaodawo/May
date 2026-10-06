import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileEvalStore } from "../dist/file-store.js";
import { createEvalPlan } from "../dist/index.js";
async function directory() { const root = fileURLToPath(new URL("../../../.eval-results/store-tests", import.meta.url)); await mkdir(root, { recursive: true }); return mkdtemp(join(root, "run-")); }
function plan(id) { return createEvalPlan({ id, seed: 1, repetitions: 1, concurrency: 1, cases: [{ id: "case", version: "1", description: "Write a file", input: [{ role: "user", content: [{ type: "text", text: "Write a file" }] }], environment: { id: "local", version: "1" }, evaluators: [{ id: "files", version: "1", required: true }], limits: { prepareTimeoutMs: 1_000, executionTimeoutMs: 1_000, evaluationTimeoutMs: 1_000, cleanupTimeoutMs: 1_000, runBudget: {} } }], variants: [{ id: "command", version: "1", execution: { id: "command", version: "1" }, configuration: {} }] }); }
test("exclusive writer prevents two stores from owning one experiment", async () => {
  const root = await directory(); const first = new FileEvalStore({ directory: root }); const second = new FileEvalStore({ directory: root }); let release;
  try {
    const results = await Promise.allSettled([first.acquire("exclusive"), second.acquire("exclusive")]); assert.equal(results.filter(value => value.status === "fulfilled").length, 1); release = results.find(value => value.status === "fulfilled").value;
    await assert.rejects((results[0].status === "fulfilled" ? second : first).createPlan(plan("exclusive")), /Acquire/);
    await release(); release = undefined; const acquired = await second.acquire("exclusive"); await second.createPlan(plan("exclusive")); await acquired(); assert.equal((await first.readPlan("exclusive")).trials.length, 1);
  } finally { await release?.(); await rm(root, { recursive: true, force: true }); }
});
test("writer ownership from a terminated host can be acquired again", async () => {
  const root = await directory(); const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/writer-lock.mjs", import.meta.url)), root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolvePromise, reject) => { child.stdout.once("data", resolvePromise); child.once("error", reject); child.once("exit", () => reject(new Error("Writer terminated before acquiring ownership"))); });
    const ended = new Promise(resolvePromise => child.once("exit", resolvePromise)); child.kill(); await ended;
    const store = new FileEvalStore({ directory: root }); const release = await store.acquire("locked"); await store.createPlan(plan("locked")); await release(); assert.equal((await store.readPlan("locked")).experiment.id, "locked");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
});
test("JSON record validation rejects corrupted plans and trial states", async () => {
  const root = await directory(); const store = new FileEvalStore({ directory: root }); const release = await store.acquire("records");
  try {
    await store.createPlan(plan("records")); await writeFile(join(root, "records", "plan.json"), JSON.stringify({ schemaVersion: 1, experiment: { id: "records" } })); await assert.rejects(store.readPlan("records"), /Invalid experiment plan/);
    await mkdir(join(root, "records", "trials")); await writeFile(join(root, "records", "trials", "trial-1.json"), JSON.stringify({ trial: { id: "trial-1", experimentId: "records" }, taskVerdict: "passed" })); await assert.rejects(store.readTrial("records", "trial-1"), /Invalid trial state/);
    await assert.rejects(store.createPlan({ schemaVersion: 1, experiment: { id: "incomplete" } }), /Acquire/);
    await assert.rejects(store.writeTrial("records", { trial: { id: "other", experimentId: "records" } }), /Invalid trial state/);
    assert.equal(await store.readTrial("records", "absent"), undefined);
  } finally { await release(); await rm(root, { recursive: true, force: true }); }
});
test("evidence filenames hash bounded identifiers and telemetry uses bounded JSON records", async () => {
  const root = await directory(); const store = new FileEvalStore({ directory: root }); const release = await store.acquire("evidence");
  try {
    await store.createPlan(plan("evidence")); const content = "verified"; const reference = await store.writeEvidence("evidence", "trial-1", { id: "grader:2:../result", mediaType: "text/plain", bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }, content); assert.match(reference.path, /^evidence\/trial-1\/[a-f0-9]{64}\.txt$/); assert.equal(await readFile(join(root, "evidence", reference.path), "utf8"), content);
    await store.appendEvent("evidence", "trial-1", { id: "call", type: "model-call" }); const text = await readFile(join(root, "evidence", "events", "trial-1.jsonl"), "utf8"); assert.equal((text.match(/\n/g) ?? []).length, 1); assert.equal(JSON.parse(text).type, "model-call");
    await assert.rejects(store.appendEvent("evidence", "trial-1", { id: "large", type: "identity", identities: { sessionIds: ["a".repeat(70_000)] } }), /64 KiB/);
    await assert.rejects(store.acquire("../escape"), /safe identifier/); await assert.rejects(access(join(root, "escape")));
  } finally { await release(); await rm(root, { recursive: true, force: true }); }
});
