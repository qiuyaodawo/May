import assert from "node:assert/strict";
import test from "node:test";
import { defineAgent } from "../../application/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { parallelToolScheduler } from "../../core/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent } from "../dist/index.js";

const policy = { version: "v1", authorize: () => true, authorizeMessage: () => true, authorizeDelegation: () => true };
const answer = (text, toolCalls) => ({ role: "assistant", content: [{ type: "text", text }], ...(toolCalls ? { toolCalls } : {}) });
const call = (name, input, id = name) => ({ name, input, id });
const task = (id) => ({ id, agent: id, input: id });
const unknown = async () => ({ status: "recovery-required", detail: "No durable outcome" });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function agent(store, respond) {
  return createApplicationAgent({ version: "v1", store, messaging: true,
    definition: ({ tools }) => defineAgent({ tools, permissionPolicy: () => "allow", toolScheduler: parallelToolScheduler,
      model: { async *stream(request) { yield { type: "response.completed", message: await respond(request) }; } },
    }),
  });
}
function inbox(request) {
  return request.messages.filter((message) => message.role === "user").at(-1).content.find((part) => part.type === "json" && part.value.messages)?.value.messages ?? [];
}

test("peer request/reply yields one slot and delivers host-stamped messages once per turn", async (t) => {
  const sessions = new InMemorySessionStore(), seen = [];
  const runtime = await CoordinationRuntime.create({ id: "peer-roundtrip", store: new InMemoryCoordinationStore(), policy,
    tasks: [task("alice"), task("bob")], limits: { maxConcurrent: 1 }, agents: {
      alice: agent(sessions, (request) => {
        const inputs = request.messages.filter((message) => message.role === "user");
        if (inputs.length === 1) return answer("", [call("send_message", { toTaskId: "bob", text: "Question" }), call("wait_for_messages", {})]);
        seen.push(inbox(request));
        assert.ok(request.messages.filter((message) => message.role === "tool").length === 2);
        return answer("Finished with reply");
      }),
      bob: agent(sessions, (request) => {
        if (request.messages.some((message) => message.role === "tool")) return answer("Replied");
        seen.push(inbox(request));
        return answer("", [call("send_message", { toTaskId: "alice", text: "Reply" })]);
      }),
    },
  });
  t.after(() => runtime.close());
  const state = await runtime.wait();
  assert.deepEqual(state.tasks.map((task) => task.status), ["completed", "completed"]);
  assert.deepEqual(seen.map((messages) => messages.map(({ fromTaskId, text }) => [fromTaskId, text])), [[["alice", "Question"]], [["bob", "Reply"]]]);
  assert.deepEqual(state.messages.map(({ fromTaskId, fromTurn, deliveredTurn }) => [fromTaskId, fromTurn, deliveredTurn]), [["alice", 0, 0], ["bob", 0, 1]]);
  const history = await sessions.read(state.tasks[0].sessionId);
  assert.equal(history.filter((event) => event.type === "run.yielded").length, 1);
  assert.equal(history.filter((event) => event.type === "input.submitted").length, 2);
});

test("message arrival during execution cannot mutate its inbox or lose the subsequent wakeup", async (t) => {
  const entered = deferred(), sent = deferred(); const seen = []; let stale;
  const runtime = await CoordinationRuntime.create({ id: "inbox-race", store: new InMemoryCoordinationStore(), policy,
    tasks: [task("reader"), task("writer")], limits: { maxConcurrent: 2 }, agents: {
      reader: { version: "v1", recover: unknown, async execute(execution, context) {
        seen.push(execution.messages.map((message) => message.text));
        if (execution.task.turn === 0) {
          entered.resolve(); await sent.promise;
          assert.deepEqual(execution.messages, []);
          await context.waitForMessages("read-next"); return { yielded: true };
        }
        return { text: "Read" };
      } },
      writer: { version: "v1", recover: unknown, async execute(_execution, context) {
        await entered.promise; stale = context.sendMessage;
        const receipt = await context.sendMessage("send-once", { toTaskId: "reader", text: "During Run" });
        assert.deepEqual(await context.sendMessage("send-once", { toTaskId: "reader", text: "During Run" }), receipt);
        await assert.rejects(context.sendMessage("send-once", { toTaskId: "reader", text: "Different" }), /reused/);
        sent.resolve(); return { text: "Sent" };
      } },
    },
  });
  t.after(() => runtime.close());
  const state = await runtime.wait();
  assert.deepEqual(state.tasks.map((task) => task.status), ["completed", "completed"]);
  assert.deepEqual(seen, [[], ["During Run"]]); assert.equal(state.messages.length, 1);
  await assert.rejects(stale("late", { toTaskId: "reader", text: "Late" }), /no longer active/);
});

test("message policy, payload, quotas and incompatible waits reject without partial state", async (t) => {
  for (const mode of ["denied", "allowed", "turns"]) {
    let checked = false;
    const runtime = await CoordinationRuntime.create({ id: `message-limits-${mode}`, store: new InMemoryCoordinationStore(),
      policy: mode === "denied" ? { version: "v1", authorize: () => true } : policy,
      tasks: [task("sender"), task("recipient")], limits: { maxConcurrent: 1, maxMessages: 1, maxMessageBytes: 4, maxTaskTurns: mode === "turns" ? 1 : 2 },
      agents: {
        sender: { version: "v1", recover: unknown, async execute(_execution, context) {
          if (mode === "turns") {
            await assert.rejects(context.waitForMessages("no-more-turns"), /No task turn/); checked = true; return { text: "Done" };
          }
          await assert.rejects(context.sendMessage("spoof", { toTaskId: "recipient", text: "Hi", fromTaskId: "host" }), /only/);
          await assert.rejects(context.sendMessage("large", { toTaskId: "recipient", text: "中文" }), /maxMessageBytes/);
          await assert.rejects(context.sendMessage("self", { toTaskId: "sender", text: "Hi" }), /another task/);
          if (mode === "denied") {
            await assert.rejects(context.sendMessage("denied", { toTaskId: "recipient", text: "Hi" }), /authorization denied/);
            checked = true; return { text: "Denied safely" };
          }
          await context.sendMessage("accepted", { toTaskId: "recipient", text: "Hi" });
          await assert.rejects(context.sendMessage("quota", { toTaskId: "recipient", text: "More" }), /maxMessages/);
          await context.waitForMessages("wait");
          await assert.rejects(context.delegate("conflict", [{ id: "child", agent: "recipient", input: "child" }]), /combine/);
          checked = true; return { yielded: true };
        } },
        recipient: { version: "v1", recover: unknown, async execute(_execution, context) {
          if (mode === "denied") await assert.rejects(context.sendMessage("finished", { toTaskId: "sender", text: "Hi" }), /not accepting/);
          return { text: "Done" };
        } },
      },
    });
    t.after(() => runtime.close());
    const state = await runtime.wait();
    assert.equal(checked, true);
    assert.equal(state.messages?.length ?? 0, mode === "allowed" ? 1 : 0);
    assert.equal(state.tasks[1].status, "completed");
    assert.equal(state.tasks[0].status, mode === "allowed" ? "waiting" : "completed");
    if (mode === "allowed") {
      await runtime.cancel("cancel-wait", "sender");
      assert.equal(runtime.snapshot().tasks[0].status, "cancelled");
    }
  }
});

test("ambiguous message and inbox commits recover without resending or resubmitting inputs", async (t) => {
  for (const point of ["send", "dispatch", "input", "missing-sender"]) {
    const durable = new InMemoryCoordinationStore(), sessionStore = new InMemorySessionStore();
    let injected = false, readerCalls = 0, writerCalls = 0, lostSession;
    const sessions = { read: (id) => id === lostSession ? Promise.resolve([]) : sessionStore.read(id), async append(event) {
      await sessionStore.append(event);
      if (!injected && point === "input" && event.type === "input.submitted" && event.inputId.endsWith(":1")) {
        injected = true; throw new Error("Lost input acknowledgement");
      }
    } };
    const store = { async acquire(id) {
      const journal = await durable.acquire(id);
      return { ...journal, async commit(state, revision) {
        await journal.commit(state, revision);
        if (!injected && ((["send", "missing-sender"].includes(point) && state.messages?.length === 1) ||
          (point === "dispatch" && state.tasks[0].turn === 1 && state.tasks[0].status === "running"))) {
          injected = true; throw new Error("Lost message acknowledgement");
        }
      } };
    } };
    const agents = {
      reader: agent(sessions, (request) => {
        readerCalls++;
        return inbox(request).length ? answer("Read") : answer("", [call("wait_for_messages", {})]);
      }),
      writer: agent(sessions, (request) => {
        writerCalls++;
        return request.messages.some((message) => message.role === "tool") ? answer("Sent") : answer("", [call("send_message", { toTaskId: "reader", text: "Evidence" })]);
      }),
    };
    const options = { id: `crash-${point}`, store, agents, policy };
    const runtime = await CoordinationRuntime.create({ ...options, tasks: [task("reader"), task("writer")], limits: { maxConcurrent: 1 } });
    if (point === "input") assert.equal((await runtime.wait()).tasks[0].status, "recovery-required");
    else await assert.rejects(runtime.wait(), /acknowledgement/);
    await runtime.close();
    if (point === "missing-sender") lostSession = runtime.snapshot().tasks[1].sessionId;
    const before = writerCalls;
    const resumed = await CoordinationRuntime.resume({ ...options, store: durable });
    t.after(() => resumed.close());
    const state = await resumed.wait();
    assert.equal(injected, true); assert.equal(state.messages.length, 1); assert.equal(writerCalls, before);
    assert.equal(state.tasks[0].status, point === "input" ? "recovery-required" : "completed");
    if (point === "missing-sender") assert.equal(state.tasks[1].status, "recovery-required");
    assert.equal(readerCalls, point === "input" ? 1 : 2);
    const history = await sessions.read(state.tasks[0].sessionId);
    assert.equal(history.filter((event) => event.type === "input.submitted" && event.inputId.endsWith(":1")).length, 1);
  }
});
