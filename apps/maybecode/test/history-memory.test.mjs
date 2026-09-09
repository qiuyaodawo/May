import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionStore } from "@may/session";
import { MaybeCodeApplication } from "../dist/index.js";

const notes = { goal: "Fix the parser", constraints: "Keep existing APIs", progress: "Found the failing input", nextSteps: "Add a regression test" };
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (name, input = {}) => ({ role: "assistant", content: [], toolCalls: [{ id: `call_${name}_${Math.random()}`, name, input }] });
const options = (model, store = new InMemorySessionStore()) => ({
  workspace: process.cwd(), model, store, tools: [], skills: false,
  instructions: "Complete the task.", autoCompactionMode: "history-reference",
  contextBudget: { contextWindowTokens: 10000, compactTriggerRatio: 0.8 },
  contextSummarizer: { summarize() { assert.fail("Do not summarize history"); } },
});

test("queries budget, warns early, saves notes and resets within one user turn; memory survives resume", async (t) => {
  const requests = [];
  const store = new InMemorySessionStore();
  const model = { async *stream(request) {
    requests.push(request);
    const step = requests.length;
    const message = step === 1 ? call("large")
      : step === 2 ? call("get_context_remaining")
      : step === 3 ? call("context_notes", { action: "save", notes })
      : step === 4 ? call("new_context") : assistant("continuing from notes");
    yield { type: "response.completed", message };
  } };
  const app = await MaybeCodeApplication.open({ ...options(model, store), tools: [{
    name: "large", description: "Read input", inputSchema: { type: "object" },
    async execute() { return "x".repeat(26000); },
  }], permissionPolicy: () => "allow" });
  t.after(() => app.close());
  await (await app.submit({ input: "Fix the parser" })).result;
  assert.equal(requests.length, 5);
  assert.match(JSON.stringify(requests[1].messages), /Context capacity reminder/);
  const budget = requests[2].messages.find((item) => item.role === "tool" && item.name === "get_context_remaining").content[0].value;
  assert.ok(budget.remainingBeforeReset > 0 && budget.remainingBeforeReset < 1600);
  assert.equal(budget.contextWindowTokens, 10000);
  const last = JSON.stringify(requests[4].messages);
  assert.match(last, /Add a regression test/);
  assert.doesNotMatch(last, /x{100}/);
  assert.doesNotMatch(last, /Context capacity reminder/);
  assert.equal(requests[4].messages.filter((item) => item.role === "user").length, 1);
  const history = await app.history();
  const checkpoint = history.find((event) => event.type === "context.compacted");
  assert.ok(checkpoint);
  assert.ok(history.find((event) => event.type === "tool.completed" && event.call.name === "new_context").seq < checkpoint.seq);
  assert.ok(history.find((event) => event.type === "state.updated").seq < checkpoint.seq);
  assert.equal(history.filter((event) => event.type === "input.submitted").length, 1);
  await app.close();

  let resumedCalls = 0;
  const resumed = await MaybeCodeApplication.open({ ...options({ async *stream(request) {
    resumedCalls++;
    if (resumedCalls === 2) {
      const result = request.messages.filter((item) => item.role === "tool" && item.name === "context_notes").at(-1).content[0].value;
      assert.deepEqual(result.notes, notes);
      assert.equal(result.readyForReset, false, "new input requires refreshed notes");
    }
    yield { type: "response.completed", message: resumedCalls === 1 ? call("context_notes", { action: "read" }) : assistant("resumed") };
  } }, store), sessionId: app.sessionId, resume: true });
  t.after(() => resumed.close());
  await (await resumed.submit({ input: "Continue" })).result;
});

test("new tool outcomes invalidate notes and a reset request cannot discard them", async (t) => {
  let step = 0;
  const app = await MaybeCodeApplication.open({ ...options({ async *stream(request) {
    step++;
    if (step === 4) {
      const result = request.messages.filter((item) => item.role === "tool").at(-1);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /fresh context_notes/);
    }
    yield { type: "response.completed", message: step === 1 ? call("context_notes", { action: "save", notes })
      : step === 2 ? call("work") : step === 3 ? call("new_context") : assistant("must update notes") };
  } }), tools: [{ name: "work", description: "Work", inputSchema: { type: "object" }, async execute() { return "new finding"; } }], permissionPolicy: () => "allow" });
  t.after(() => app.close());
  await (await app.submit({ input: "Work" })).result;
  assert.equal((await app.history()).some((event) => event.type === "context.compacted"), false);
});

test("a failed compaction checkpoint restores the old model view", async (t) => {
  const backing = new InMemorySessionStore();
  let step = 0;
  const app = await MaybeCodeApplication.open(options({ async *stream() {
    step++;
    yield { type: "response.completed", message: step === 1 ? call("context_notes", { action: "save", notes }) : call("new_context") };
  } }, {
    read: (id) => backing.read(id),
    async append(event) {
      if (event.type === "context.compacted") throw new Error("disk failure");
      return backing.append(event);
    },
  }));
  t.after(() => app.close());
  // Long request is retained, but tool arguments/results make the old view larger.
  await assert.rejects((await app.submit({ input: "Fix the parser " + "a".repeat(3000) })).result, /disk failure/);
  const inspection = await app.inspectContext();
  assert.ok(inspection.messageCount >= 5, "the pre-reset tool transcript is restored");
  assert.equal((await app.history()).some((event) => event.type === "context.compacted"), false);
});

test("failed note persistence stops the run without creating a handoff or reset", async (t) => {
  const backing = new InMemorySessionStore();
  let calls = 0;
  const app = await MaybeCodeApplication.open(options({ async *stream() {
    calls++;
    yield { type: "response.completed", message: call("context_notes", { action: "save", notes }) };
  } }, {
    read: (id) => backing.read(id),
    async append(event) {
      if (event.type === "state.updated") throw new Error("notes disk failure");
      return backing.append(event);
    },
  }));
  t.after(() => app.close());
  await assert.rejects((await app.submit({ input: "Fix the parser" })).result);
  assert.equal(calls, 1);
  const history = await app.history();
  assert.equal(history.some((event) => event.type === "state.updated" || event.type === "context.compacted"), false);
  assert.ok((await app.inspectContext()).messageCount >= 2);
});
