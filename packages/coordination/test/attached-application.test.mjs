import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AgentApplication } from "@sortedyuan/may";
import { runtimeHooks } from "@sortedyuan/may/core";
import { InMemorySessionStore } from "@sortedyuan/may/session";
import { OpenAIChatCompletionsModel } from "@sortedyuan/providers/openai-compatible";
import { createAttachedApplicationAgent } from "../dist/index.js";

function execution(sessionId, turn = 0, start = 0) {
  return {
    coordinationId: "attached-verification",
    task: { id: "main", agent: "worker", input: "Continue", dependsOn: [], agentVersion: "v1",
      dispatchId: "dispatch", sessionId, status: "running", turn, sessionStartTurn: start },
    dependencies: [],
  };
}

function model() {
  return new OpenAIChatCompletionsModel({ apiKey: "unused-lifecycle-verification", model: "gpt-4o" });
}

async function suspendedApplication(t, sessionId) {
  const store = new InMemorySessionStore();
  const entered = Promise.withResolvers();
  const application = await AgentApplication.open({ sessionId, store, model: model(), plugins: [{
    id: "verification.suspend-run", version: "1.0.0", requiresHooks: [runtimeHooks.runStarted],
    setup(context) {
      context.on(runtimeHooks.runStarted, async (_event, { signal }) => {
        entered.resolve();
        signal.throwIfAborted();
        await once(signal, "abort");
        signal.throwIfAborted();
      });
    },
  }] });
  t.after(() => application.close());
  return { application, store, entered: entered.promise };
}

test("attached recovery retains the host input identity after a yielded turn", async t => {
  for (const start of [0, 3]) {
    const sessionId = `attached-identity-${start}`;
    const store = new InMemorySessionStore();
    const message = { role: "user", content: [{ type: "text", text: "Continue" }] };
    const result = (runId, yielded) => ({ runId, steps: 1, modelCalls: 1, toolCalls: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Finished" }] },
      ...(yielded ? { finishReason: "yielded" } : {}),
    });
    const events = [
      { type: "session.created" },
      { type: "input.submitted", inputId: "host-steering-input", message },
      { type: "run.started", runId: "first" },
      { type: "run.yielded", runId: "first", result: result("first", true) },
      { type: "input.submitted", inputId: `dispatch:${start + 1}`, message },
      { type: "run.started", runId: "second" },
      { type: "run.completed", runId: "second", result: result("second", false) },
    ];
    for (const [index, event] of events.entries()) {
      await store.append({ ...event, sessionId, seq: index + 1, timestamp: index });
    }
    const application = await AgentApplication.open({ sessionId, store, resume: true, model: model() });
    t.after(() => application.close());
    const worker = createAttachedApplicationAgent({ version: "v1", attach: () => application,
      read: id => store.read(id), submit: () => ({ input: "Continue" }),
      identity: (current, turn) => turn.first ? "host-steering-input" : `${current.task.dispatchId}:${turn.index}`,
    });
    const recovered = await worker.recover(execution(sessionId, start + 1, start));
    assert.deepEqual(recovered, { status: "completed", output: { text: "Finished", runId: "second" } });
  }
});

for (const mode of ["submit", "continue"]) {
  for (const [coordinationLimit, hostLimit] of [[25, 100], [100, 25]]) {
    test(`attached ${mode} enforces the smaller duration budget (${coordinationLimit}, ${hostLimit})`, { timeout: 3000 }, async t => {
      const sessionId = `attached-budget-${mode}-${coordinationLimit}`;
      const { application, store } = await suspendedApplication(t, sessionId);
      const worker = createAttachedApplicationAgent({ version: "v1", mode, attach: () => application,
        read: id => store.read(id), submit: () => ({ input: "Continue", runBudget: { maxDurationMs: hostLimit } }),
      });
      await assert.rejects(worker.execute({ ...execution(sessionId), runBudget: { maxDurationMs: coordinationLimit } },
        { signal: t.signal, report() {} }), { code: "RUN_BUDGET_EXCEEDED" });
      const history = await store.read(sessionId);
      const exceeded = history.find(event => event.type === "run.budget.exceeded");
      assert.equal(exceeded.dimension, "durationMs");
      assert.equal(exceeded.limit, 25);
      assert.equal(exceeded.budget.modelCalls, 0);
    });
  }
}

test("concurrent attached execution preserves the active application after history reads", { timeout: 3000 }, async t => {
  const sessionId = "attached-concurrency";
  const { application, store, entered } = await suspendedApplication(t, sessionId);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const worker = createAttachedApplicationAgent({ version: "v1", attach: () => application,
    read: id => store.read(id), submit: () => ({ input: "Continue" }),
  });
  const current = execution(sessionId);
  const context = { signal: AbortSignal.any([controller.signal, t.signal]), report() {} };
  const running = assert.rejects(worker.execute(current, context), { code: "RUN_CANCELLED" });
  await Promise.all([entered, assert.rejects(worker.execute(current, context), /Task Session already active/)]);
  assert.deepEqual(await worker.recover(current), { status: "recovery-required", detail: "Task Session is still active" });
  controller.abort();
  await running;
  const history = await store.read(sessionId);
  assert.equal(history.filter(event => event.type === "input.submitted").length, 1);
  assert.equal((await worker.recover(current)).status, "cancelled");
});
