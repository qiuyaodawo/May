import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineAgent } from "../../application/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { FileSessionStore } from "../../session/dist/file-store.js";
import { parallelToolScheduler } from "../../core/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent } from "../dist/index.js";
import { FileCoordinationStore } from "../dist/file-store.js";

const policy = { version: "v1", authorize: () => true, authorizeDelegation: () => true };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const child = (id, agent = "worker") => ({ id, agent, input: id });
const delegate = (...tasks) => ({ ...answer(""), toolCalls: [{ id: "delegate", name: "delegate_tasks", input: { tasks } }] });
const root = { id: "root", agent: "manager", input: "root" };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function manager(model, store = new InMemorySessionStore()) {
  return createApplicationAgent({ version: "v1", store, delegation: true,
    definition: ({ tools }) => defineAgent({ model, tools, toolScheduler: parallelToolScheduler, permissionPolicy: () => "allow" }),
  });
}
function worker(model, store = new InMemorySessionStore()) {
  return createApplicationAgent({ version: "v1", store, definition: defineAgent({ model, permissionPolicy: () => "deny" }) });
}
async function directory(t) {
  const parent = resolve(tmpdir()); const path = await mkdtemp(join(parent, "may-delegation-"));
  const part = relative(parent, resolve(path));
  assert.ok(!isAbsolute(part) && !part.startsWith("..") && part.startsWith("may-delegation-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test("nested delegation yields the only slot, drains parallel tool calls and wakes with paired history", async (t) => {
  const sessions = new InMemorySessionStore(); const calls = [];
  const lead = manager({ async *stream(request) {
    const inputs = request.messages.filter((message) => message.role === "user");
    const origin = inputs[0].content[0].text;
    calls.push(origin);
    // Every historical tool call is closed before the next model request.
    const pending = new Set();
    for (const message of request.messages) {
      for (const call of message.toolCalls ?? []) pending.add(call.id);
      if (message.role === "tool") pending.delete(message.toolCallId);
    }
    assert.equal(pending.size, 0);
    let message;
    if (inputs.length > 1) {
      const results = inputs.at(-1).content.find((part) => part.type === "json").value;
      assert.deepEqual(results.map((result) => result.status), origin === "root" ? ["completed", "failed"] : ["completed"]);
      message = answer(`finished ${origin}`);
    } else if (origin === "root") {
      message = { ...answer(""), toolCalls: [
        { id: "a", name: "delegate_tasks", input: { tasks: [child("middle", "manager")] } },
        { id: "b", name: "delegate_tasks", input: { tasks: [child("sibling")] } },
      ] };
    } else message = delegate(child("leaf"));
    yield { type: "response.completed", message };
  } }, sessions);
  const runtime = await CoordinationRuntime.create({ id: "nested", store: new InMemoryCoordinationStore(),
    agents: { manager: lead, worker: worker({ async *stream(request) {
      const id = request.messages.at(-1).content[0].text; calls.push(id);
      if (id === "sibling") throw new Error("Independent worker failed");
      yield { type: "response.completed", message: answer(id) };
    } }, sessions) }, policy, tasks: [root], limits: { maxConcurrent: 1, maxDepth: 2 },
  });
  t.after(() => runtime.close());
  const state = await runtime.wait();
  assert.ok(state.tasks.every((task) => task.status === (task.id === "sibling" ? "failed" : "completed")));
  assert.deepEqual(calls, ["root", "middle", "sibling", "leaf", "middle", "root"]);
  assert.equal(state.tasks.find((task) => task.id === "root").turn, 1);
  for (const task of state.tasks.filter((task) => task.agent === "manager")) {
    const history = await sessions.read(task.sessionId);
    assert.equal(history.filter((event) => event.type === "run.yielded").length, 1);
    assert.equal(history.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(history.filter((event) => event.type === "run.interrupted").length, 0);
    const inputs = history.filter((event) => event.type === "input.submitted");
    assert.deepEqual(inputs.map((event) => event.inputId), [`${task.dispatchId}:0`, `${task.dispatchId}:1`]);
    const reopened = await defineAgent({ model: { async *stream() { throw new Error("Duplicate input must not call a model"); } }, permissionPolicy: () => "deny" })
      .open({ store: sessions, sessionId: task.sessionId, resume: true });
    await assert.rejects(reopened.submit({ input: "duplicate", inputId: inputs[0].inputId }), /Input already submitted/);
    await reopened.close();
  }
});

test("delegation authority, graph quotas, depth and turn limits reject without partially creating children", async (t) => {
  for (const scenario of ["denied", "tasks", "turns", "depth"]) {
    let workers = 0;
    const lead = manager({ async *stream(request) {
      const origin = request.messages.find((message) => message.role === "user").content[0].text;
      const used = request.messages.some((message) => message.role === "tool");
      yield { type: "response.completed", message: used ? answer("handled outcome") :
        scenario === "depth" ? delegate(child(origin === "root" ? "middle" : "too-deep", "manager")) : delegate(child("a"), child("b")) };
    } });
    const runtime = await CoordinationRuntime.create({ id: scenario, store: new InMemoryCoordinationStore(), tasks: [root],
      agents: { manager: lead, worker: worker({ async *stream() { workers++; yield { type: "response.completed", message: answer("done") }; } }) },
      policy: scenario === "denied" ? { version: "v1", authorize: () => true } : policy,
      limits: scenario === "tasks" ? { maxTasks: 2 } : scenario === "turns" ? { maxTaskTurns: 1 } : { maxDepth: 1 },
    });
    t.after(() => runtime.close());
    const state = await runtime.wait();
    assert.equal(state.tasks.length, scenario === "depth" ? 2 : 1);
    assert.ok(state.tasks.every((task) => task.status === "completed"));
    assert.equal(workers, 0);
  }
});

test("yield and wakeup crash windows recover by turn identity without replaying submitted input", async (t) => {
  const path = await directory(t);
  for (const point of ["yield-record", "wake-dispatch", "wake-input"]) {
    const disk = new FileCoordinationStore(join(path, point));
    const sessionDisk = new FileSessionStore(join(path, `${point}-sessions`));
    let injected = false, managerCalls = 0, workerCalls = 0;
    const sessions = point !== "wake-input" ? sessionDisk : {
      read: (id) => sessionDisk.read(id),
      async append(event) {
        await sessionDisk.append(event);
        if (!injected && event.type === "input.submitted" && event.inputId?.endsWith(":1")) {
          injected = true; throw new Error("Lost wakeup input acknowledgement");
        }
      },
    };
    const store = { async acquire(id) {
      const journal = await disk.acquire(id);
      return { ...journal, async commit(state, revision) {
        const task = state.tasks.find((task) => task.id === "root");
        if (!injected && ((point === "yield-record" && task.status === "waiting") ||
          (point === "wake-dispatch" && task.turn === 1 && task.status === "running"))) {
          injected = true;
          if (point === "wake-dispatch") await journal.commit(state, revision);
          throw new Error("Lost coordination acknowledgement");
        }
        await journal.commit(state, revision);
      } };
    } };
    const agents = {
      manager: manager({ async *stream(request) {
        managerCalls++;
        yield { type: "response.completed", message: request.messages.filter((message) => message.role === "user").length === 1 ? delegate(child("work")) : answer("done") };
      } }, sessions),
      worker: worker({ async *stream() { workerCalls++; yield { type: "response.completed", message: answer("evidence") }; } }, sessions),
    };
    const options = { id: point, store, agents, policy };
    const runtime = await CoordinationRuntime.create({ ...options, tasks: [root], limits: { maxConcurrent: 1 } });
    if (point === "wake-input") assert.equal((await runtime.wait()).tasks[0].status, "recovery-required");
    else await assert.rejects(runtime.wait(), /acknowledgement/);
    await runtime.close();
    const resumed = await CoordinationRuntime.resume({ ...options, store: disk });
    const state = await resumed.wait();
    if (point === "wake-input") {
      assert.equal(state.tasks[0].status, "recovery-required");
      assert.equal(managerCalls, 1);
      await resumed.resolveRecovery("verified-stop", "root", "Host verified no wakeup model request was sent; stop this task without replay.", { status: "cancelled", detail: "Stopped" });
    } else {
      assert.equal(state.tasks[0].status, "completed"); assert.equal(managerCalls, 2);
    }
    await resumed.close();
    assert.equal(workerCalls, 1);
    const history = await sessions.read(state.tasks[0].sessionId);
    assert.equal(history.filter((event) => event.type === "input.submitted" && event.inputId.endsWith(":1")).length, 1);
  }
});

test("cancelling a waiting parent cascades to its children and does not wake on a late result", async (t) => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const runtime = await CoordinationRuntime.create({ id: "cancel-family", store: new InMemoryCoordinationStore(), policy,
    tasks: [root], limits: { maxConcurrent: 1 }, agents: {
      manager: manager({ async *stream() { calls++; yield { type: "response.completed", message: delegate(child("work")) }; } }),
      worker: { version: "v1", async execute() { entered.resolve(); await release.promise; return { text: "late external result" }; },
        async recover() { return { status: "recovery-required", detail: "Unknown effects" }; },
      },
    },
  });
  t.after(() => runtime.close());
  const done = runtime.wait(); await entered.promise;
  assert.equal(runtime.snapshot().tasks[0].status, "waiting");
  await runtime.cancel("cancel-family", "root"); release.resolve();
  const state = await done;
  assert.deepEqual(state.tasks.map((task) => task.status), ["cancelled", "cancelled"]);
  assert.equal(state.tasks[1].output.text, "late external result"); assert.equal(calls, 1);
});
