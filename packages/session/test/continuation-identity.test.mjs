import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryContext, May } from "../../core/dist/index.js";
import { OpenAIChatCompletionsModel } from "../../providers/openai-compatible/dist/index.js";
import { Session, inspectSessionRunOutcome } from "../dist/index.js";
import { FileSessionStore } from "../dist/file-store.js";

function runtime(messages = []) {
  return new May({
    model: new OpenAIChatCompletionsModel({ apiKey: "unused-before-model-dispatch", model: "gpt-4o" }),
    context: new InMemoryContext({ messages }),
  });
}

test("identified continuation records cancellation durably and rejects duplicates across restart", async t => {
  const base = fileURLToPath(new URL("../../../review/architecture-fix-20261023/session/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "identity-"));
  assert.ok(directory.startsWith(base));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
