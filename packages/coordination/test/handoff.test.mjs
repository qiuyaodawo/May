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

const policy = { version: "v1", authorize: () => true, authorizeDelegation: () => true, authorizeMessage: () => true, authorizeHandoff: () => true };
const task = (id, agent = id) => ({ id, agent, input: id });
const answer = (text, toolCalls) => ({ role: "assistant", content: [{ type: "text", text }], ...(toolCalls ? { toolCalls } : {}) });
const call = (name, input) => ({ id: name, name, input });
const delegate = (id, role) => answer("", [call("delegate_tasks", { tasks: [task(id, role)] })]);
const transfer = (agent = "target") => answer("", [call("handoff_task", { agent, input: "Verified facts only" })]);
const unknown = async () => ({ status: "recovery-required", detail: "Unknown effects" });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function adapter(store, respond, capabilities = {}) {
  return createApplicationAgent({ version: "v1", store, ...capabilities,
    definition: ({ tools }) => defineAgent({ tools, permissionPolicy: () => "allow",
      model: { async *stream(request) { yield { type: "response.completed", message: await respond(request) }; } },
    }),
  });
}

test("handoff preserves nested task identity while the fresh controller delegates and completes downstream work", async (t) => {
  const sessions = new InMemorySessionStore(), store = new InMemoryCoordinationStore();
  let sourceCalls = 0, targetCalls = 0;
  const options = { id: "nested-handoff", store, policy, agents: {
    manager: adapter(sessions, (request) => request.messages.filter((message) => message.role === "user").length === 1
      ? delegate("work", "source") : answer("Manager received final result"), { delegation: true }),
    source: adapter(sessions, () => {
      sourceCalls++;
      return sourceCalls === 1 ? { ...delegate("analysis", "worker"), content: [{ type: "text", text: "PRIVATE SOURCE HISTORY" }] } : transfer();
    }, { delegation: true, handoff: true }),
    target: adapter(sessions, (request) => {
      targetCalls++;
      const text = JSON.stringify(request.messages);
      assert.ok(!text.includes("PRIVATE SOURCE HISTORY"));
      assert.ok(!text.includes("analysis evidence"));
      const inputs = request.messages.filter((message) => message.role === "user");
      assert.equal(inputs[0].content[0].text, "work");
      assert.deepEqual(inputs[0].content.find((part) => part.type === "json" && part.value.handoff).value.handoff,
        { fromAgent: "source", input: "Verified facts only" });
      if (inputs.length === 1) return delegate("check", "worker");
      assert.deepEqual(inputs.at(-1).content.find((part) => part.type === "json").value.map((result) => result.text), ["check evidence"]);
      return transfer("finisher");
    }, { delegation: true, handoff: true }),
    finisher: adapter(sessions, () => answer("Final controller completed work")),
    worker: adapter(sessions, (request) => answer(`${request.messages.find((message) => message.role === "user").content[0].text} evidence`)),
    reporter: adapter(sessions, () => answer("Report")),
  } };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("root", "manager"), { ...task("report", "reporter"), dependsOn: ["root"] }],
    limits: { maxConcurrent: 1, maxTasks: 5, maxTaskTurns: 5 } });
  const state = await runtime.wait();
  assert.ok(state.tasks.every((task) => task.status === "completed"));
  const work = state.tasks.find((task) => task.id === "work");
  assert.equal(work.agent, "finisher"); assert.equal(work.parentTaskId, "root");
  assert.equal(work.turn, 4); assert.equal(work.sessionStartTurn, 4); assert.equal(work.handoffs.length, 2);
  assert.equal(work.handoffs[0].from.turn, 1);
  assert.notEqual(work.handoffs[0].from.sessionId, work.sessionId);
  const target = work.handoffs[1].from;
  assert.deepEqual((await sessions.read(target.sessionId)).filter((event) => event.type === "input.submitted").map((event) => event.inputId), [`${target.dispatchId}:2`, `${target.dispatchId}:3`]);
  assert.deepEqual((await sessions.read(work.sessionId)).filter((event) => event.type === "input.submitted").map((event) => event.inputId), [`${work.dispatchId}:4`]);
  assert.equal((await sessions.read(work.handoffs[0].from.sessionId)).filter((event) => event.type === "run.yielded").length, 2);
  await runtime.close();
  const resumed = await CoordinationRuntime.resume(options); t.after(() => resumed.close());
  assert.ok((await resumed.wait()).tasks.every((task) => task.status === "completed"));
  assert.equal(sourceCalls, 2); assert.equal(targetCalls, 2);
});

test("handoff authority, quotas and conflicting commands fail closed without partial transfers", async (t) => {
  for (const mode of ["denied", "parent-denied", "dispatch-denied", "turns", "quota", "wait"]) {
    let checked = false, targetCalls = 0, grants = 0, stale;
    const runtime = await CoordinationRuntime.create({ id: `handoff-${mode}`, store: new InMemoryCoordinationStore(),
      policy: { ...policy, authorizeHandoff: mode === "denied" ? undefined : () => mode !== "dispatch-denied" || ++grants === 1,
        authorizeDelegation: mode === "parent-denied" ? (_parent, child) => child.agent === "source" : policy.authorizeDelegation },
      tasks: [mode === "parent-denied" ? task("owner", "manager") : task("work", "source")], limits: { maxConcurrent: 1, maxTaskTurns: mode === "turns" ? 1 : 4, maxHandoffs: 1, maxHandoffBytes: 4 },
      agents: {
        manager: { version: "v1", recover: unknown, async execute(execution, context) {
          if (execution.task.turn === 0) { await context.delegate("owned-work", [task("work", "source")]); return { yielded: true }; }
          return { text: "Owner done" };
        } },
        source: { version: "v1", recover: unknown, async execute(_execution, context) {
          stale = context.handoff;
          await assert.rejects(context.handoff("spoof", { agent: "target", input: "Hi", from: "host" }), /only/);
          await assert.rejects(context.handoff("large", { agent: "target", input: "中文" }), /maxHandoffBytes/);
          await assert.rejects(context.handoff("self", { agent: "source", input: "Hi" }), /different agent/);
          await assert.rejects(context.handoff("missing", { agent: "absent", input: "Hi" }), /Unknown agent/);
          if (mode === "wait") {
            await context.waitForMessages("wait");
            await assert.rejects(context.handoff("conflict", { agent: "target", input: "Hi" }), /overlap/);
            checked = true; return { yielded: true };
          }
          if (["denied", "parent-denied", "turns"].includes(mode)) {
            await assert.rejects(context.handoff("rejected", { agent: "target", input: "Hi" }), mode === "turns" ? /No task turn/ : /authorization denied/);
            checked = true; return { text: "Not transferred" };
          }
          const receipt = await context.handoff("accepted", { agent: "target", input: "Hi" });
          assert.deepEqual(await context.handoff("accepted", { agent: "target", input: "Hi" }), receipt);
          await assert.rejects(context.handoff("accepted", { agent: "target", input: "New" }), /reused/);
          await assert.rejects(context.handoff("again", { agent: "target", input: "Hi" }), /pending handoff/);
          await assert.rejects(context.waitForMessages("late-wait"), /pending handoff/);
          await assert.rejects(context.delegate("late-child", [task("child", "target")]), /pending handoff/);
          await assert.rejects(context.sendMessage("late-message", { toTaskId: "other", text: "Hi" }), /pending handoff/);
          checked = true; return { yielded: true };
        } },
        target: { version: "v1", recover: unknown, async execute(_execution, context) {
          targetCalls++;
          await assert.rejects(context.handoff("over-quota", { agent: "source", input: "Hi" }), /maxHandoffs/);
          return { text: "Finished" };
        } },
      },
    });
    t.after(() => runtime.close());
    const state = await runtime.wait(); assert.equal(checked, true);
    const work = state.tasks.find((task) => task.id === "work");
    assert.equal(work.status, mode === "dispatch-denied" ? "failed" : mode === "wait" ? "waiting" : "completed");
    assert.equal(targetCalls, mode === "quota" ? 1 : 0);
    assert.equal(work.handoffs?.length ?? 0, ["quota", "dispatch-denied"].includes(mode) ? 1 : 0);
    await assert.rejects(stale("stale", { agent: "target", input: "Hi" }), /no longer active/);
  }
});

test("handoff never forwards old pending mail and cancellation wins before a complete tool-step yield", async (t) => {
  const entered = deferred(), mailed = deferred(); let targetCalls = 0;
  const first = await CoordinationRuntime.create({ id: "handoff-mail", store: new InMemoryCoordinationStore(), policy,
    tasks: [task("work", "source"), task("peer")], limits: { maxConcurrent: 2 }, agents: {
      source: { version: "v1", recover: unknown, async execute(execution, context) {
        if (execution.task.turn === 0) {
          entered.resolve(); await mailed.promise;
          await assert.rejects(context.handoff("too-early", { agent: "target", input: "Summary" }), /pending messages/);
          await context.waitForMessages("receive"); return { yielded: true };
        }
        assert.deepEqual(execution.messages.map((message) => message.text), ["Private old-controller mail"]);
        await context.handoff("accepted", { agent: "target", input: "Summary" }); return { yielded: true };
      } },
      peer: { version: "v1", recover: unknown, async execute(_execution, context) {
        await entered.promise; await context.sendMessage("mail", { toTaskId: "work", text: "Private old-controller mail" });
        mailed.resolve(); return { text: "Sent" };
      } },
      target: { version: "v1", recover: unknown, async execute(execution) {
        targetCalls++; assert.deepEqual(execution.messages, []); return { text: "Done" };
      } },
    },
  });
  t.after(() => first.close());
  const state = await first.wait();
  assert.ok(state.tasks.every((task) => task.status === "completed")); assert.equal(targetCalls, 1);
  assert.equal(state.messages[0].deliveredTurn, 1); assert.equal(state.tasks[0].sessionStartTurn, 2);

  const accepted = deferred(), rejected = deferred(), release = deferred(), held = deferred();
  const durable = new InMemoryCoordinationStore(), sessions = new InMemorySessionStore();
  const store = { async acquire(id) {
    const journal = await durable.acquire(id);
    return { ...journal, async commit(snapshot, revision) {
      await journal.commit(snapshot, revision);
      if (snapshot.tasks[0].pendingHandoff) accepted.resolve();
    } };
  } };
  const source = createApplicationAgent({ version: "v1", store: sessions, handoff: true,
    definition: ({ tools }) => defineAgent({ tools: [...tools, {
      name: "hold", description: "An already-started operation", inputSchema: { type: "object" }, parse: (input) => input,
      async execute() { held.resolve(); await release.promise; return "settled"; },
    }], toolScheduler: parallelToolScheduler, permissionPolicy: () => "allow",
    model: { async *stream() { yield { type: "response.completed", message: answer("", [call("handoff_task", { agent: "target", input: "Summary" }), call("hold", {})]) }; } },
    }),
  });
  const second = await CoordinationRuntime.create({ id: "handoff-cancel", store, policy,
    tasks: [task("work", "source"), task("peer")], limits: { maxConcurrent: 2 }, agents: {
      source,
      target: { version: "v1", recover: unknown, async execute() { targetCalls++; return { text: "Must not run" }; } },
      peer: { version: "v1", recover: unknown, async execute(_execution, context) {
        await accepted.promise;
        await assert.rejects(context.sendMessage("during-handoff", { toTaskId: "work", text: "Not forwarded" }), /not accepting/);
        rejected.resolve(); return { text: "Rejected safely" };
      } },
    },
  });
  t.after(() => second.close());
  const done = second.wait(); await Promise.all([held.promise, rejected.promise]);
  assert.equal(second.snapshot().tasks[0].agent, "source"); assert.equal(targetCalls, 1);
  await second.cancel("cancel-transfer", "work"); release.resolve();
  const cancelled = await done;
  assert.equal(cancelled.tasks[0].status, "cancelled"); assert.equal(targetCalls, 1);
  assert.equal(cancelled.tasks[0].handoffs?.length ?? 0, 0);
});

test("handoff crash windows use durable yield and controller identities without replay", async (t) => {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "may-handoff-"));
  const part = relative(parent, resolve(directory));
  assert.ok(!isAbsolute(part) && !part.startsWith("..") && part.startsWith("may-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const point of ["intent", "missing-source", "transfer-before", "transfer-after", "dispatch", "input", "wake-input", "missing-wake"]) {
    const disk = new FileCoordinationStore(join(directory, point));
    const sessionDisk = new FileSessionStore(join(directory, `${point}-sessions`));
    let injected = false, sourceCalls = 0, targetCalls = 0, lostSession;
    const sessions = { read: (id) => id === lostSession ? Promise.resolve([]) : sessionDisk.read(id), async append(event) {
      await sessionDisk.append(event);
      if (!injected && event.type === "input.submitted" &&
        ((point === "input" && event.inputId.endsWith(":1")) || (point === "wake-input" && event.inputId.endsWith(":2")))) {
        injected = true; throw new Error("Lost target input acknowledgement");
      }
    } };
    const store = { async acquire(id) {
      const journal = await disk.acquire(id);
      return { ...journal, async commit(snapshot, revision) {
        const work = snapshot.tasks[0];
        const crash = !injected && ((["intent", "missing-source"].includes(point) && work.pendingHandoff) ||
          (["transfer-before", "transfer-after"].includes(point) && work.agent === "target" && work.status === "queued") ||
          (point === "dispatch" && work.agent === "target" && work.status === "running") ||
          (point === "missing-wake" && work.agent === "target" && work.status === "queued" && work.turn === 2));
        if (crash && point === "transfer-before") { injected = true; throw new Error("Lost transfer acknowledgement"); }
        await journal.commit(snapshot, revision);
        if (crash) { injected = true; throw new Error("Lost transfer acknowledgement"); }
      } };
    } };
    const agents = {
      source: adapter(sessions, () => { sourceCalls++; return transfer(); }, { handoff: true }),
      target: adapter(sessions, (request) => {
        targetCalls++;
        return ["wake-input", "missing-wake"].includes(point) && request.messages.filter((message) => message.role === "user").length === 1 ? delegate("child", "worker") : answer("Done");
      }, { delegation: true }),
      worker: adapter(sessions, () => answer("Evidence")),
    };
    const options = { id: point, store, policy, agents };
    const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("work", "source")], limits: { maxConcurrent: 1 } });
    if (["input", "wake-input"].includes(point)) assert.equal((await runtime.wait()).tasks[0].status, "recovery-required");
    else await assert.rejects(runtime.wait(), /acknowledgement/);
    await runtime.close();
    if (["missing-source", "missing-wake"].includes(point)) lostSession = runtime.snapshot().tasks[0].sessionId;
    const resumed = await CoordinationRuntime.resume({ ...options, store: disk });
    const state = await resumed.wait(); await resumed.close();
    assert.equal(injected, true); assert.equal(sourceCalls, 1);
    if (["intent", "missing-source"].includes(point)) {
      assert.equal(state.tasks[0].agent, "source"); assert.equal(targetCalls, 0);
      assert.ok(["failed", "cancelled", "recovery-required"].includes(state.tasks[0].status));
      if (point === "missing-source") assert.equal(state.tasks[0].status, "recovery-required");
    } else {
      assert.equal(state.tasks[0].agent, "target"); assert.equal(state.tasks[0].handoffs.length, 1);
      assert.equal(state.tasks[0].status, ["input", "wake-input", "missing-wake"].includes(point) ? "recovery-required" : "completed");
      assert.equal(targetCalls, point === "input" ? 0 : 1);
      const history = await sessionDisk.read(state.tasks[0].sessionId);
      assert.equal(history.filter((event) => event.type === "input.submitted" && event.inputId.endsWith(["wake-input", "missing-wake"].includes(point) ? ":2" : ":1")).length, point === "missing-wake" ? 0 : 1);
    }
    if (point === "transfer-after") await assert.rejects(CoordinationRuntime.resume({ ...options, store: disk,
      agents: { ...agents, source: { ...agents.source, version: "changed" } },
    }), /version changed/);
  }
});
