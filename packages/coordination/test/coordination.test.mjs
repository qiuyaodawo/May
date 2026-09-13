import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineAgent } from "../../application/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { FileSessionStore } from "../../session/dist/file-store.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent, pipeline, parallelTasks } from "../dist/index.js";
import { FileCoordinationStore } from "../dist/file-store.js";
import { recoverFileLock } from "@may/session/file-store";
import { spawnSync } from "node:child_process";

const policy = { version: "v1", authorize: () => true };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const task = (id, dependsOn = []) => ({ id, agent: "worker", input: id, dependsOn });
const statuses = (runtime) => Object.fromEntries(runtime.snapshot().tasks.map(({ id, status }) => [id, status]));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function agent(model, store = new InMemorySessionStore(), permissionPolicy = () => "allow", tools = []) {
  return createApplicationAgent({ version: "v1", store, definition: defineAgent({ model, tools, permissionPolicy }) });
}
async function directory(t) {
  const parent = resolve(tmpdir());
  const path = await mkdtemp(join(parent, "may-coordination-"));
  const within = relative(parent, resolve(path));
  assert.ok(!isAbsolute(within) && !within.startsWith("..") && within.startsWith("may-coordination-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("parallel reduction and pipelines share the graph scheduler and isolated Sessions", async (t) => {
  const first = deferred(), second = deferred(), both = deferred();
  const requests = [];
  const sessions = new InMemorySessionStore();
  const model = { async *stream(request) {
    requests.push(request);
    const input = request.messages.at(-1).content[0].text;
    if (requests.length === 2) both.resolve();
    if (input === "a") await first.promise;
    if (input === "b") await second.promise;
    yield { type: "response.completed", message: {
      ...answer(`done ${input}`), content: [{ type: "reasoning", text: "private reasoning" }, { type: "text", text: `done ${input}` }],
    }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }};
  const runtime = await CoordinationRuntime.create({ id: "parallel", store: new InMemoryCoordinationStore(),
    agents: { worker: agent(model, sessions) }, policy,
    tasks: parallelTasks([task("a"), task("b")], task("reduce")), limits: { maxConcurrent: 2 },
  });
  t.after(() => runtime.close());
  const completed = runtime.wait();
  await both.promise;
  assert.deepEqual(statuses(runtime), { a: "running", b: "running", reduce: "queued" });
  first.resolve(); second.resolve();
  const snapshot = await completed;
  assert.deepEqual(statuses(runtime), { a: "completed", b: "completed", reduce: "completed" });
  const dependencyData = requests[2].messages.at(-1).content.find((part) => part.type === "json").value;
  assert.deepEqual(dependencyData, [{ taskId: "a", text: "done a" }, { taskId: "b", text: "done b" }]);
  assert.equal(JSON.stringify(requests[2]).includes("private reasoning"), false);
  assert.equal(new Set(snapshot.tasks.map((task) => task.sessionId)).size, 3);
  assert.ok(Object.isFrozen(snapshot.tasks[0]));
  for (const task of snapshot.tasks) assert.equal((await sessions.read(task.sessionId)).filter((event) => event.type === "input.submitted").length, 1);

  const chain = await CoordinationRuntime.create({ id: "chain", store: new InMemoryCoordinationStore(),
    agents: { worker: agent(model) }, policy, tasks: pipeline([task("one"), task("two"), task("three")]),
  });
  t.after(() => chain.close());
  assert.deepEqual((await chain.wait()).tasks.map((task) => task.status), ["completed", "completed", "completed"]);
});

test("graph validation and execution-time authority fail closed without blocking independent branches", async (t) => {
  const calls = [];
  const worker = agent({ async *stream(request) { calls.push(request.messages.at(-1).content[0].text); yield { type: "response.completed", message: answer("ok") }; } });
  const base = { id: "gates", store: new InMemoryCoordinationStore(), agents: { worker }, policy };
  await assert.rejects(CoordinationRuntime.create({ ...base, tasks: [task("a", ["b"]), task("b", ["a"])] }), /cycle/);
  await assert.rejects(CoordinationRuntime.create({ ...base, tasks: [task("a", ["missing"])] }), /Unknown dependency/);
  await assert.rejects(CoordinationRuntime.create({ ...base, tasks: [task("a"), task("b")], limits: { maxTasks: 1 } }), /1-1 tasks/);
  await assert.rejects(CoordinationRuntime.create({ ...base, tasks: [task("a")], policy: { version: "v1", authorize: () => false } }), /denied/);
  await assert.rejects(CoordinationRuntime.create({ ...base, tasks: [task("a")], policy: { version: "v1", authorize: () => "deny" } }), /denied/);
  let allow = true;
  const runtime = await CoordinationRuntime.create({ ...base, tasks: [task("a"), task("dependent", ["a"]), task("independent")],
    policy: { version: "v1", authorize: (task) => allow || task.id === "independent" },
  });
  t.after(() => runtime.close());
  allow = false;
  await runtime.wait();
  assert.deepEqual(statuses(runtime), { a: "failed", dependent: "failed", independent: "completed" });
  assert.deepEqual(calls, ["independent"]);
});

test("approvals remain attached to their task and Run budgets remain per task", async (t) => {
  const tool = { name: "check", description: "Check", inputSchema: { type: "object" }, async execute() { return "ok"; } };
  const sessions = new InMemorySessionStore();
  const worker = agent({ async *stream(request) {
    if (!request.messages.some((message) => message.role === "tool")) yield { type: "response.completed", usage: { totalTokens: 1 },
      message: { ...answer(""), toolCalls: [{ id: "check-1", name: "check", input: {} }] } };
    else yield { type: "response.completed", message: answer("done"), usage: { totalTokens: 1 } };
  } }, sessions, () => "ask", [tool]);
  const runtime = await CoordinationRuntime.create({ id: "approvals", store: new InMemoryCoordinationStore(), agents: { worker }, policy,
    tasks: [task("a"), task("b")], limits: { runBudget: { maxModelCalls: 1 } },
  });
  t.after(() => runtime.close());
  const approvals = [];
  const relay = (async () => { for await (const event of runtime.events) {
    if (event.type !== "agent.event" || event.event.type !== "permission.event" || event.event.event.type !== "approval.requested") continue;
    const request = event.event.event.request;
    approvals.push(event.taskId);
    assert.equal(await runtime.resolveApproval(event.taskId === "a" ? "b" : "a", request.id, "allow"), false);
    assert.equal(await runtime.resolveApproval(event.taskId, request.id, "allow"), true);
  } })();
  await runtime.wait();
  assert.deepEqual(statuses(runtime), { a: "failed", b: "failed" });
  await runtime.close(); await relay;
  assert.deepEqual(approvals.sort(), ["a", "b"]);
  for (const task of runtime.snapshot().tasks) {
    assert.equal((await sessions.read(task.sessionId)).find((event) => event.type === "run.budget.exceeded").dimension, "modelCalls");
  }
});

test("cancelled tool effects require reconciliation, with idempotent host commands and no replay", async (t) => {
  const entered = deferred(); let effects = 0;
  const worker = agent({ async *stream() { yield { type: "response.completed", message: {
    ...answer(""), toolCalls: [{ id: "effect", name: "effect", input: {} }],
  } }; } }, new InMemorySessionStore(), () => "allow", [{ name: "effect", description: "Effect", inputSchema: { type: "object" },
    async execute(_input, context) {
      effects++; entered.resolve();
      await delay(30_000, undefined, { signal: context.signal });
      return "done";
    },
  }]);
  const runtime = await CoordinationRuntime.create({ id: "cancel", store: new InMemoryCoordinationStore(), agents: { worker }, policy, tasks: [task("a"), task("dependent", ["a"])] });
  t.after(() => runtime.close());
  const waiting = runtime.wait();
  await entered.promise;
  await runtime.cancel("cancel-once", "a");
  await waiting;
  assert.deepEqual(statuses(runtime), { a: "recovery-required", dependent: "queued" });
  const revision = runtime.snapshot().revision;
  await runtime.cancel("cancel-once", "a");
  assert.equal(runtime.snapshot().revision, revision);
  await assert.rejects(runtime.cancel("cancel-once", "dependent"), /different input/);
  await runtime.resolveRecovery("verified", "a", "Host verified the effect was cancelled after a partial write.", { status: "cancelled", detail: "Verified" });
  await runtime.resolveRecovery("verified", "a", "Host verified the effect was cancelled after a partial write.", { detail: "Verified", status: "cancelled" });
  assert.deepEqual(statuses(runtime), { a: "cancelled", dependent: "failed" });
  assert.equal(effects, 1);
});

test("durable dispatch and completed Sessions reconcile across uncertain journal commits", async (t) => {
  const path = await directory(t);
  for (const crashPoint of ["dispatch-ack", "result-write"]) {
    const disk = new FileCoordinationStore(join(path, crashPoint));
    const sessions = new FileSessionStore(join(path, `${crashPoint}-sessions`));
    let calls = 0;
    const worker = agent({ async *stream() { calls++; yield { type: "response.completed", message: answer("durable") }; } }, sessions);
    let injected = false;
    const store = { async acquire(id) {
      const journal = await disk.acquire(id);
      return { ...journal, async commit(snapshot, expected) {
        if (!injected && ((crashPoint === "dispatch-ack" && snapshot.tasks[0].status === "running") ||
          (crashPoint === "result-write" && snapshot.tasks[0].status === "completed"))) {
          injected = true;
          if (crashPoint === "dispatch-ack") await journal.commit(snapshot, expected);
          throw new Error("Simulated uncertain disk acknowledgement");
        }
        return journal.commit(snapshot, expected);
      } };
    } };
    const options = { id: crashPoint, store, agents: { worker }, policy };
    const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a")] });
    await assert.rejects(runtime.wait(), /uncertain disk/);
    await runtime.close();
    assert.equal(calls, crashPoint === "dispatch-ack" ? 0 : 1);
    const resumed = await CoordinationRuntime.resume({ ...options, store: disk });
    assert.equal(calls, crashPoint === "dispatch-ack" ? 0 : 1);
    assert.equal((await resumed.wait()).tasks[0].output.text, "durable");
    await resumed.close();
    assert.equal(calls, 1);
  }
});

test("file journals enforce ownership, version matching, tail repair and complete-record validation", async (t) => {
  const path = await directory(t);
  const store = new FileCoordinationStore(path);
  const worker = agent({ async *stream() { yield { type: "response.completed", message: answer("ok") }; } });
  const options = { id: "journal", store, agents: { worker }, policy };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a")] });
  await assert.rejects(CoordinationRuntime.resume(options), { code: "EEXIST" });
  await runtime.wait(); await runtime.close();
  await assert.rejects(CoordinationRuntime.resume({ ...options, policy: { ...policy, version: "v2" } }), /version changed/);
  await assert.rejects(CoordinationRuntime.resume({ ...options, agents: { worker: { ...worker, version: "v2" } } }), /version changed/);
  const file = join(path, `${Buffer.from("journal").toString("base64url")}.jsonl`);
  const before = await readFile(file, "utf8");
  await appendFile(file, '{"unterminated":');
  const resumed = await CoordinationRuntime.resume(options); await resumed.close();
  assert.equal(await readFile(file, "utf8"), before);
  await appendFile(file, '{"complete-corruption":true}\n');
  await assert.rejects(CoordinationRuntime.resume(options), /identity\/format/);
  await writeFile(file, before);
  const repaired = await CoordinationRuntime.resume(options); await repaired.close();
});

test("bounded journals checkpoint snapshots, reject oversized inputs, and expose guarded lock recovery", async (t) => {
  const path = await directory(t);
  const store = new FileCoordinationStore(path, 2048);
  const worker = agent({ async *stream() { yield { type: "response.completed", message: answer("ok") }; } });
  const options = { id: "compact", store, agents: { worker }, policy };
  await assert.rejects(CoordinationRuntime.create({ ...options, tasks: [{ ...task("a"), input: "超".repeat(4) }], limits: { maxInputBytes: 10 } }), /maxInputBytes/);
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a")] });
  await runtime.wait();
  const expected = runtime.snapshot();
  await runtime.close();
  assert.deepEqual(await store.inspect("compact"), expected);
  const file = join(path, `${Buffer.from("compact").toString("base64url")}.jsonl`);
  assert.ok(Buffer.byteLength(await readFile(file)) <= 2048);
  const resumed = await CoordinationRuntime.resume(options);
  await resumed.close();
  const lock = join(path, "owner.lock");
  const live = JSON.stringify({ pid: process.pid });
  await writeFile(lock, live);
  await assert.rejects(recoverFileLock(lock, { expectedContents: live, confirmHostsStopped: true }), /alive/);
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  const stale = JSON.stringify({ pid: child.pid });
  await writeFile(lock, stale);
  await recoverFileLock(lock, { expectedContents: stale, confirmHostsStopped: true });
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("deadlines stop pending dispatches and uncertain adapters are not restarted", async (t) => {
  const began = deferred(); let calls = 0;
  const worker = { version: "v1", async execute(_execution, { signal }) {
    calls++; began.resolve(); await delay(30_000, undefined, { signal }); return { text: "late" };
  }, async recover() { return { status: "recovery-required", detail: "Unknown remote effects" }; } };
  const store = new InMemoryCoordinationStore();
  const options = { id: "deadline", store, agents: { worker }, policy };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a"), task("b")], limits: { maxConcurrent: 1, maxDurationMs: 100 } });
  const waiting = runtime.wait(); await began.promise; await waiting;
  assert.deepEqual(statuses(runtime), { a: "recovery-required", b: "cancelled" });
  await runtime.close();
  const resumed = await CoordinationRuntime.resume(options);
  t.after(() => resumed.close());
  await resumed.wait(); assert.equal(calls, 1);
});
