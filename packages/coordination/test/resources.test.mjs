import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSharedBudget } from "../dist/shared-budget.js";
import { FileArtifactStore } from "../dist/artifact-store.js";
import { TaskWorkspaceManager } from "../dist/task-workspace.js";

const signal = new AbortController().signal;
const request = { messages: [], tools: [] };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const response = (totalTokens = 10) => ({ type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens } });
async function consume(model, modelCallId) { const events = []; for await (const event of model.stream(request, { signal, modelCallId })) events.push(event); return events; }
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), "may-resources-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test("shared budget reserves concurrent capacity, settles before results, and reconciles unknown usage without replay", async (t) => {
  const directory = await temporary(t);
  const limits = { maxModelCalls: 8, maxTotalTokens: 100, maxCostUsd: 1, tokenPrices: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
  let ledger = await FileSharedBudget.open(directory, "team", limits);
  let release; let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const held = ledger.wrapModel({ async *stream() { calls++; started(); await gate; yield response(); } }, { reservation: { totalTokens: 60, costUsd: 0.5 } });
  const first = consume(held, "first"); await begun;
  await assert.rejects(consume(held, "second"), /insufficient/);
  assert.equal(calls, 1);
  await assert.rejects(ledger.close(), /active/);
  release(); await first;
  assert.equal((await ledger.totals()).totalTokens, 10);
  assert.equal((await ledger.totals()).costUsd, 12 / 1_000_000);
  await consume(held, "second");
  await assert.rejects(consume(held, "first"), /already reserved/);

  const missing = ledger.wrapModel({ async *stream() { const value = response(); delete value.usage; yield value; } }, { reservation: { totalTokens: 20, costUsd: 0.1 } });
  await assert.rejects(consume(missing, "unknown"), /unavailable/);
  assert.equal((await ledger.totals()).blocked, true);
  await assert.rejects(consume(held, "blocked"), /blocked/);
  await ledger.close();
  await assert.rejects(FileSharedBudget.open(directory, "team", { ...limits, maxModelCalls: 9 }), /changed limits/);
  ledger = await FileSharedBudget.open(directory, "team", limits);
  await ledger.reconcile("unknown", { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, "Provider receipt checked by host");
  assert.equal((await ledger.totals()).blocked, false);
  assert.equal((await ledger.totals()).modelCalls, 3);

  const over = ledger.wrapModel({ async *stream() { yield response(15); } }, { reservation: { totalTokens: 10, costUsd: 0.1 } });
  const delivered = [];
  await assert.rejects(async () => { for await (const event of over.stream(request, { signal, modelCallId: "over" })) delivered.push(event); }, /not released/);
  assert.deepEqual(delivered, []);
  await ledger.reconcile("over", response(15).usage, "Known usage verified; accept reservation overrun");
  await ledger.close();

  // Simulate a durable reservation with no provider outcome after process loss.
  const path = join(directory, `${sha("team")}.budget.jsonl`);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const state = JSON.parse(lines.at(-1)); state.revision++;
  state.calls.push({ id: "crash", status: "pending", reservation: { totalTokens: 10, costUsd: 0.1 } });
  await appendFile(path, `${JSON.stringify(state)}\n`);
  ledger = await FileSharedBudget.open(directory, "team", limits);
  assert.equal((await ledger.snapshot()).calls.at(-1).status, "unknown");
  assert.equal(calls, 2);
  await ledger.close();
});

test("artifacts are immutable, scoped, bounded, durable, and integrity-checked", async (t) => {
  const directory = await temporary(t);
  const options = { policyVersion: "team-v1", authorizeRead: (task, ref) => task === "manager" && ref.ownerTaskId === "worker", maxArtifactBytes: 10, maxTotalBytes: 16, maxArtifacts: 2 };
  let store = await FileArtifactStore.open(directory, "team", options);
  const worker = store.forTask("worker");
  const artifact = await worker.publish("stable-command", { name: "answer.txt", text: "result" });
  assert.deepEqual(await worker.publish("stable-command", { name: "answer.txt", text: "result" }), artifact);
  await assert.rejects(worker.publish("stable-command", { name: "answer.txt", text: "changed" }), /different content/);
  await assert.rejects(store.forTask("stranger").read(artifact.id), /not authorized/);
  assert.equal((await store.forTask("manager").read(artifact.id)).text, "result");
  await assert.rejects(worker.publish("bad-name", { name: "../escape", text: "x" }), /simple name/);
  await assert.rejects(worker.publish("too-big", { name: "huge", text: "x".repeat(11) }), /quota/);
  const publish = worker.tools().find((tool) => tool.name === "publish_artifact");
  assert.throws(() => publish.parse({ name: "ok", text: "x", ownerTaskId: "manager" }), /fields/);
  await store.close();
  store = await FileArtifactStore.open(directory, "team", options);
  assert.equal((await store.forTask("manager").read(artifact.id)).sha256, sha("result"));
  const blob = join(directory, sha("team"), "blobs", `${artifact.id}.blob`);
  await writeFile(blob, "badbad");
  await assert.rejects(store.forTask("worker").read(artifact.id), /integrity/);
  await store.close();
});

test("task workspaces share one filtered baseline, never alter source, and preserve isolated edits on reopen", async (t) => {
  const root = await temporary(t); const source = join(root, "source"); const directory = join(root, "private");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "main.ts"), "original");
  await writeFile(join(source, ".env"), "SECRET=not copied");
  await writeFile(join(source, "secret.key"), "not copied");
  await mkdir(join(source, "node_modules")); await writeFile(join(source, "node_modules", "package.json"), "{}");
  await mkdir(join(root, "outside")); await writeFile(join(root, "outside", "private.txt"), "not copied");
  await symlink(join(root, "outside"), join(source, "escape"), process.platform === "win32" ? "junction" : "dir");
  let manager = await TaskWorkspaceManager.open({ sourceDirectory: source, directory });
  const first = await manager.prepare("first");
  assert.deepEqual(await readdir(first.directory), ["src"]);
  await writeFile(join(first.directory, "src", "main.ts"), "task edit");
  await writeFile(join(source, "src", "main.ts"), "later source edit");
  const second = await manager.prepare("second");
  assert.equal(await readFile(join(second.directory, "src", "main.ts"), "utf8"), "original");
  assert.equal(await readFile(join(source, "src", "main.ts"), "utf8"), "later source edit");
  assert.deepEqual((await manager.changes("first")).map(({ path, kind }) => ({ path, kind })), [{ path: "src/main.ts", kind: "modified" }]);
  await manager.close();
  manager = await TaskWorkspaceManager.open({ sourceDirectory: source, directory });
  assert.deepEqual(await manager.prepare("first"), first);
  assert.equal(await readFile(join(first.directory, "src", "main.ts"), "utf8"), "task edit");
  await manager.close();
  const forbidden = join(source, "must-not-create");
  await assert.rejects(TaskWorkspaceManager.open({ sourceDirectory: source, directory: forbidden }), /overlap/);
  assert.ok(!(await readdir(source)).includes("must-not-create"));
});
