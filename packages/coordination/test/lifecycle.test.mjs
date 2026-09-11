import assert from "node:assert/strict";
import test from "node:test";
import { defineAgent } from "../../application/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent } from "../dist/index.js";

const policy = { version: "v1", authorize: () => true, authorizeRetry: () => true, authorizeGraphRewrite: () => true };
const task = (id, dependsOn = []) => ({ id, agent: "worker", input: id, dependsOn });
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("explicit attempts keep failed Sessions, fresh input identity and lifetime bounds without retrying dependants", async (t) => {
  const sessions = new InMemorySessionStore(), store = new InMemoryCoordinationStore();
  const executions = [];
  let calls = 0;
  const worker = createApplicationAgent({ version: "v1", store: sessions, definition: ({ execution }) => {
    executions.push(execution);
    return defineAgent({ model: { async *stream(request) {
      calls++;
      if (calls === 1) throw new Error("Known provider rejection before effects");
      if (execution.task.id === "a") {
        assert.equal(request.messages[0].content[0].text, "a");
        assert.equal(request.messages[0].content.find((part) => part.type === "json").value.retry.attempt, 1);
      }
      yield { type: "response.completed", message: answer("done") };
    } } });
  } });
  const options = { id: "attempts", store, policy, agents: { worker } };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a"), task("b", ["a"])], limits: { maxAttempts: 2 } });
  t.after(() => runtime.close());
  const failed = await runtime.wait();
  assert.deepEqual(failed.tasks.map(({ status }) => status), ["failed", "failed"]);
  await runtime.retryTask("retry-a", "a", "Provider failure was verified; a new attempt is authorized.");
  const completed = await runtime.wait();
  assert.deepEqual(completed.tasks.map(({ status }) => status), ["completed", "failed"]);
  const a = completed.tasks[0];
  assert.equal(a.attempt, 1);
  assert.equal(a.turn, 1);
  assert.deepEqual(a.attempts[0].task, failed.tasks[0]);
  assert.notEqual(a.sessionId, failed.tasks[0].sessionId);
  assert.notEqual(a.dispatchId, failed.tasks[0].dispatchId);
  assert.equal((await sessions.read(failed.tasks[0].sessionId)).filter((event) => event.type === "input.submitted").length, 1);
  assert.equal((await sessions.read(a.sessionId)).find((event) => event.type === "input.submitted").inputId, `${a.dispatchId}:1`);
  const revision = completed.revision;
  await runtime.retryTask("retry-a", "a", "Provider failure was verified; a new attempt is authorized.");
  assert.equal(runtime.snapshot().revision, revision);
  await assert.rejects(runtime.retryTask("retry-a", "a", "Different reason"), /different input/);
  await runtime.retryTask("retry-b", "b", "Upstream is now successful; this dependant never ran.");
  assert.deepEqual((await runtime.wait()).tasks.map(({ status }) => status), ["completed", "completed"]);
  await runtime.close();
  const resumed = await CoordinationRuntime.resume(options);
  t.after(() => resumed.close());
  assert.equal((await resumed.wait()).tasks[0].attempts.length, 1);
  assert.equal(calls, 3);

  const rejected = await CoordinationRuntime.create({ id: "attempt-gates", store: new InMemoryCoordinationStore(), policy, tasks: [task("x")], limits: { maxAttempts: 2 },
    agents: { worker: { version: "v1", async execute() { throw new Error("Known failure"); }, async recover() { return { status: "failed", detail: "Verified no effects" }; } } },
  });
  t.after(() => rejected.close());
  await rejected.wait(); await rejected.retryTask("once", "x", "Safe"); await rejected.wait();
  await assert.rejects(rejected.retryTask("twice", "x", "Safe"), /maxAttempts/);
});

test("unknown effects never retry, and an uncertain retry acknowledgement resumes only the new identity", async (t) => {
  const store = new InMemoryCoordinationStore();
  let fault = false, calls = 0;
  const wrapped = { async acquire(id) {
    const journal = await store.acquire(id);
    return { ...journal, async commit(snapshot, expected) {
      await journal.commit(snapshot, expected);
      if (fault && snapshot.commands.retry) { fault = false; throw new Error("Lost retry acknowledgement"); }
    } };
  } };
  const worker = { version: "v1", async execute(execution) { calls++; if (!execution.task.attempt) throw new Error("Network lost after effect"); return { text: "new attempt" }; }, async recover() { return { status: "recovery-required", detail: "Unknown effects" }; } };
  const options = { id: "retry-ack", store: wrapped, policy, agents: { worker } };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a")] });
  await runtime.wait();
  await assert.rejects(runtime.retryTask("unsafe", "a", "Please try anyway"), /reconcile unknown effects/);
  assert.equal(calls, 1);
  await runtime.resolveRecovery("reconciled", "a", "Host verified the remote write was rolled back.", { status: "failed", detail: "Verified rollback" });
  fault = true;
  await assert.rejects(runtime.retryTask("retry", "a", "Verified rollback permits a new attempt."), /Lost retry acknowledgement/);
  await runtime.close();
  assert.equal(calls, 1);
  const resumed = await CoordinationRuntime.resume({ ...options, store });
  t.after(() => resumed.close());
  await resumed.retryTask("retry", "a", "Verified rollback permits a new attempt.");
  assert.equal((await resumed.wait()).tasks[0].output.text, "new attempt");
  assert.equal(calls, 2);
  assert.equal(resumed.snapshot().tasks[0].attempts.length, 1);

  const denied = await CoordinationRuntime.create({ id: "retry-denied", store: new InMemoryCoordinationStore(), policy: { version: "v1", authorize: () => true }, tasks: [task("a")],
    agents: { worker: { version: "v1", async execute() { throw new Error("Rejected"); }, async recover() { return { status: "cancelled", detail: "Verified no effects" }; } } },
  });
  t.after(() => denied.close()); await denied.wait();
  await assert.rejects(denied.retryTask("retry", "a", "Known cancellation"), /authorization denied/);
});

test("graph edits atomically compose future work and preserve replaced identities and lifetime task quotas", async (t) => {
  const store = new InMemoryCoordinationStore(), calls = [];
  const worker = { version: "v1", async execute(execution) { calls.push(execution.task.id); return { text: execution.dependencies.map((dependency) => dependency.output.text).join(",") || execution.task.input }; }, async recover() { return { status: "not-started" }; } };
  const options = { id: "rewrite", store, policy, agents: { worker } };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("a"), task("unused"), task("reduce", ["a"])], limits: { maxTasks: 5 } });
  t.after(() => runtime.close());
  const original = runtime.snapshot();
  const change = { add: [task("b", ["a"])], update: [task("reduce", ["a", "b"])], remove: ["unused"] };
  await runtime.rewriteGraph("edit", change);
  assert.equal(runtime.snapshot().graphChanges.length, 1);
  assert.equal(runtime.snapshot().graphChanges[0].previous.find(({ id }) => id === "reduce").sessionId, original.tasks[2].sessionId);
  assert.notEqual(runtime.snapshot().tasks.find(({ id }) => id === "reduce").sessionId, original.tasks[2].sessionId);
  const revision = runtime.snapshot().revision;
  await runtime.rewriteGraph("edit", change);
  assert.equal(runtime.snapshot().revision, revision);
  await assert.rejects(runtime.rewriteGraph("edit", { remove: ["b"] }), /different input/);
  await assert.rejects(runtime.rewriteGraph("cycle", { update: [task("a", ["reduce"])] }), /cycle/);
  assert.equal(runtime.snapshot().revision, revision);
  await assert.rejects(runtime.rewriteGraph("reuse", { add: [task("unused")] }), /history/);
  await assert.rejects(runtime.rewriteGraph("quota", { add: [task("c"), task("d")] }), /lifetime maxTasks/);
  assert.equal((await runtime.wait()).tasks.find(({ id }) => id === "reduce").output.text, "a,a");
  assert.deepEqual(calls, ["a", "b", "reduce"]);
  await runtime.close();
  const resumed = await CoordinationRuntime.resume(options);
  t.after(() => resumed.close());
  await resumed.rewriteGraph("append", { add: [task("final", ["reduce"])] });
  assert.equal((await resumed.wait()).tasks.find(({ id }) => id === "final").status, "completed");
});

test("graph rewrites deny active, submitted, mailbox-bound and unauthorized work", async (t) => {
  const began = deferred(), finish = deferred();
  const worker = { version: "v1", async execute(execution, context) {
    if (execution.task.id === "a") { await context.sendMessage("mail", { toTaskId: "b", text: "Bound to old b authority" }); began.resolve(); await finish.promise; }
    return { text: "done" };
  }, async recover() { return { status: "not-started" }; } };
  const runtime = await CoordinationRuntime.create({ id: "rewrite-gates", store: new InMemoryCoordinationStore(), policy: { ...policy, authorizeMessage: () => true }, agents: { worker },
    tasks: [task("a"), task("b", ["a"])], limits: { maxConcurrent: 1 },
  });
  t.after(() => { finish.resolve(); return runtime.close(); });
  const waiting = runtime.wait(); await began.promise;
  await assert.rejects(runtime.rewriteGraph("active", { update: [task("a")] }), /pristine/);
  await assert.rejects(runtime.rewriteGraph("mail", { update: [task("b", ["a"])] }), /different input/);
  await assert.rejects(runtime.rewriteGraph("mail-edit", { update: [task("b", ["a"])] }), /mailbox references/);
  finish.resolve(); await waiting;
  await assert.rejects(runtime.rewriteGraph("complete", { remove: ["b"] }), /pristine/);

  for (const uncertain of [false, true]) {
    const denied = await CoordinationRuntime.create({ id: `rewrite-denied-${uncertain}`, store: new InMemoryCoordinationStore(),
      policy: uncertain ? policy : { version: "v1", authorize: () => true }, tasks: [task("a")], agents: { worker: { ...worker, async recover() { return uncertain ? { status: "recovery-required", detail: "Uncertain input" } : { status: "not-started" }; } } },
    });
    t.after(() => denied.close());
    await assert.rejects(denied.rewriteGraph("edit", { update: [task("a")] }), uncertain ? /uncertain execution/ : /authorization denied/);
  }
});

test("persisted cancellations reach detached work on cascade, deadline and close without replaying execution", async (t) => {
  let calls = 0, cancellations = 0;
  const deliveries = [];
  const child = { version: "v1", async execute() { calls++; throw new Error("Lost acceptance response"); },
    async recover() { return { status: "recovery-required", detail: "Remote work may still be running" }; },
    async cancel(execution) {
      deliveries.push(execution);
      assert.equal(execution.task.cancelRequested, true);
      cancellations++;
      if (cancellations === 1) throw new Error("Cancellation acknowledgement unavailable");
    },
  };
  const runtime = await CoordinationRuntime.create({ id: "detached-cascade", store: new InMemoryCoordinationStore(), policy: { ...policy, authorizeDelegation: () => true },
    agents: { child, manager: { version: "v1", async execute(_execution, context) { await context.delegate("child", [{ id: "child", agent: "child", input: "work" }]); return { yielded: true }; }, async recover() { return { status: "not-started" }; } } },
    tasks: [{ id: "manager", agent: "manager", input: "delegate" }], limits: { maxConcurrent: 1 },
  });
  t.after(() => runtime.close()); await runtime.wait();
  // Callback capture prevents registry mutation from silently replacing cancel authority.
  child.cancel = async () => { throw new Error("Mutated callback must not run"); };
  await runtime.cancel("stop", "manager");
  assert.deepEqual(runtime.snapshot().tasks.map(({ status }) => status), ["cancelled", "recovery-required"]);
  assert.match(runtime.snapshot().tasks[1].detail, /Cancellation delivery is unconfirmed/);
  await assert.rejects(runtime.retryTask("unsafe", "child", "Try again"), /reconcile unknown effects/);
  await runtime.cancel("stop", "manager");
  assert.equal(cancellations, 2);
  assert.equal(calls, 1);
  assert.equal(deliveries[0].task.dispatchId, deliveries[1].task.dispatchId);
  await runtime.close();

  for (const trigger of ["deadline", "close"]) {
    const delivered = deferred(); let executions = 0;
    const orphan = await CoordinationRuntime.create({ id: `detached-${trigger}`, store: new InMemoryCoordinationStore(), policy,
      agents: { worker: { version: "v1", async execute() { executions++; throw new Error("Transport lost"); }, async recover() { return { status: "recovery-required", detail: "Unknown remote outcome" }; },
        async cancel(execution) { assert.equal(execution.task.cancelRequested, true); delivered.resolve(); },
      } }, tasks: [task("orphan")], ...(trigger === "deadline" ? { limits: { maxDurationMs: 40 } } : {}),
    });
    t.after(() => orphan.close());
    assert.equal((await orphan.wait()).tasks[0].status, "recovery-required");
    if (trigger === "close") await orphan.close();
    await delivered.promise;
    assert.equal(orphan.snapshot().tasks[0].status, "recovery-required");
    assert.equal(executions, 1);
  }
});
