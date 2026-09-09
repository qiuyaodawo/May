import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContextFactory } from "@may/context";
import { InMemorySessionStore } from "@may/session";
import { MaybeCodeApplication, createMaybeCodeSlashCommandSuggester, executeMaybeCodeSlashCommand } from "../dist/index.js";

const message = (role, text) => ({ role, content: [{ type: "text", text }] });
const history = [
  message("user", "old request"),
  message("assistant", "x".repeat(8000)),
  message("user", "recent request"),
  message("assistant", "y".repeat(8000)),
];

async function open(t, overrides = {}) {
  const requests = [];
  const app = await MaybeCodeApplication.open({
    workspace: process.cwd(),
    instructions: "Continue the task.",
    skills: false,
    tools: [],
    store: new InMemorySessionStore(),
    model: {
      async *stream(request) {
        requests.push(request);
        yield { type: "response.completed", message: message("assistant", "done") };
      },
    },
    contextFactory: {
      create(options) {
        return new InMemoryContextFactory().create({ ...options, messages: history });
      },
    },
    contextBudget: { contextWindowTokens: 2000, compactTriggerRatio: 0.5 },
    contextSummarizer: { summarize: () => "Earlier work completed." },
    ...overrides,
  });
  t.after(() => app.close());
  return { app, requests };
}

test("default mode retains its summary and fails instead of resetting history", async (t) => {
  const { app, requests } = await open(t);
  const run = await app.submit({ input: "current request" });
  await assert.rejects(run.result, /Automatic context compaction exhausted/);
  assert.equal(requests.length, 0);
  const checkpoints = (await app.history()).filter((event) => event.type === "context.compacted");
  assert.deepEqual(checkpoints.map((event) => event.strategy), ["summary-tail"]);
  assert.match(checkpoints[0].messages[0].content[0].text, /Earlier conversation summary/);
  assert.ok(checkpoints[0].messages.some((item) => item.content[0]?.text === "recent request"));
});

test("history-reference mode resets without invoking summary or native compaction", async (t) => {
  const { app, requests } = await open(t, {
    autoCompactionMode: "history-reference",
    contextSummarizer: { summarize() { assert.fail("summary must not run"); } },
  });
  await (await app.submit({ input: "current request" })).result;
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.some((item) => item.content[0]?.text.includes("session_history")));
  assert.equal(requests[0].messages.some((item) => item.content[0]?.text === "recent request"), false);
  assert.deepEqual(
    (await app.history()).filter((event) => event.type === "context.compacted").map((event) => event.strategy),
    ["history-reference"],
  );
});

test("native mode receives untouched history and fails without other modes", async (t) => {
  let nativeCalls = 0;
  const { app } = await open(t, {
    autoCompactionMode: "provider-native",
    model: {
      contextCompactor: {
        name: "native",
        async compact(snapshot) {
          nativeCalls++;
          assert.deepEqual(snapshot.messages.slice(0, history.length), history);
          throw new Error("native unavailable");
        },
      },
      async *stream() { assert.fail("model must not run"); },
    },
    contextSummarizer: { summarize() { assert.fail("summary must not run"); } },
  });
  await assert.rejects((await app.submit({ input: "current request" })).result, /Automatic context compaction exhausted/);
  assert.equal(nativeCalls, 1);
  assert.equal((await app.history()).some((event) => event.type === "context.compacted"), false);
});

test("manual native command is available independently of the default automatic mode", async (t) => {
  let calls = 0;
  const { app } = await open(t, {
    model: {
      contextCompactor: {
        name: "native",
        async compact() {
          calls++;
          return { messages: [message("system", "native state")], effectiveTokens: 10 };
        },
      },
      async *stream() { assert.fail("summary must not run"); },
    },
  });
  const suggestions = await createMaybeCodeSlashCommandSuggester(app)("/compact p");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].label, "provider-native");
  assert.match(suggestions[0].description, /native compactor/);
  const result = await executeMaybeCodeSlashCommand("/compact provider-native", app);
  assert.equal(result.type, "compacted");
  assert.equal(result.result.strategy, "native");
  assert.equal(calls, 1);
  assert.equal((await app.history()).filter((event) => event.type === "context.compacted").length, 1);
});

test("unsupported native mode reports an error; explicit strategies still override modes", async (t) => {
  await assert.rejects(open(t, { autoCompactionMode: "provider-native" }), /does not support provider-native/);
  const { app } = await open(t, { autoCompactionMode: "provider-native", autoCompactionStrategies: [] });
  assert.throws(() => app.compactContext("provider-native"), /does not support provider-native/);
  await (await app.submit({ input: "current request" })).result;
  assert.equal((await app.history()).some((event) => event.type === "context.compacted"), false);
});
