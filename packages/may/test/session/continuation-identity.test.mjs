import assert from "node:assert/strict";
import test from "node:test";
import { createTestDirectory } from "@sortedyuan/test-support";
import { InMemoryContext, May } from "@sortedyuan/may/core";
import { OpenAIChatCompletionsModel } from "@sortedyuan/providers/openai-compatible";
import { Session, inspectSessionRunOutcome } from "@sortedyuan/may/session";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";

function runtime(messages = []) {
  return new May({
    model: new OpenAIChatCompletionsModel({ apiKey: "unused-before-model-dispatch", model: "gpt-4o" }),
    context: new InMemoryContext({ messages }),
  });
}

test("identified continuation records cancellation durably and rejects duplicates across restart", async t => {
  const directory = await createTestDirectory(t, "may/continuation-identity");
  const store = new FileSessionStore(directory);
  const session = await Session.create({ runtime: runtime(), store });
  const controller = new AbortController();
  const run = await session.continue({ continuationId: "request:0", signal: controller.signal,
    checkpoint: async event => {
      if (event.type === "run.started") controller.abort("Cancelled at the durable execution boundary");
    },
  });
  await assert.rejects(run.result, { code: "RUN_CANCELLED" });
  assert.equal((await session.inspectRun({ continuationId: "request:0" })).status, "cancelled");
  const saved = await store.inspect(session.id);
  assert.equal(saved.find(event => event.type === "run.started").continuationId, "request:0");
  assert.equal(saved.filter(event => event.type === "continuation.submitted").length, 1);
  assert.equal(saved.filter(event => event.type === "input.submitted").length, 0);
  assert.deepEqual((await session.queryHistory({ types: ["continuation.submitted"] })).events,
    saved.filter(event => event.type === "continuation.submitted"));
  await session.closeRuntime();

  const reopened = await Session.resume({ id: session.id, store: new FileSessionStore(directory), createRuntime: messages => runtime(messages) });
  t.after(() => reopened.closeRuntime());
  assert.equal((await reopened.inspectRun({ continuationId: "request:0" })).status, "cancelled");
  await assert.rejects(reopened.continue({ continuationId: "request:0" }), /already submitted/u);
  const secondController = new AbortController();
  const first = reopened.continue({ continuationId: "request:1", signal: secondController.signal,
    checkpoint: async event => { if (event.type === "run.started") secondController.abort("Complete concurrency verification"); },
  });
  const duplicate = assert.rejects(reopened.continue({ continuationId: "request:1" }), /already submitted/u);
  await assert.rejects((await first).result, { code: "RUN_CANCELLED" });
  await duplicate;
  const history = await reopened.history();
  assert.equal(history.filter(event => event.type === "continuation.submitted" && event.continuationId === "request:1").length, 1);
  assert.equal(inspectSessionRunOutcome(history, { runId: run.id }).status, "cancelled");
  assert.equal(inspectSessionRunOutcome(history, { continuationId: "unsubmitted" }).status, "not-started");
});
