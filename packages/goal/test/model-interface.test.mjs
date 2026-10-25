import assert from "node:assert/strict";
import test from "node:test";
import { AgentApplication } from "../../application/dist/index.js";
import { InMemoryContext, May } from "../../core/dist/index.js";
import { InMemoryContextFactory } from "../../context/dist/index.js";
import { BasicTracer, InMemorySpanProcessor } from "../../observability/dist/index.js";
import { createBuiltinProviderModel, createModelCapabilityResolver, RetryingModel } from "../../providers/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { GoalController } from "../dist/index.js";

function model() {
  const resolver = createModelCapabilityResolver({ discoveries: [], adapterCapabilities: {
    "openai-chat-completions": {
      contextWindowTokens: { status: "known", source: "adapter", value: 200 },
      maxOutputTokens: { status: "known", source: "adapter", value: 20 },
    },
  } });
  return new RetryingModel(createBuiltinProviderModel({ profile: "review", provider: "review",
    adapter: "openai-chat-completions", model: "gpt-4o", options: {},
    providerConfig: { adapter: "openai-chat-completions", apiKey: "unused-during-local-validation" },
    capabilities: { fields: { "input.text": false } },
  }, { resolver }));
}

test("Goal wrapper preserves dynamic Model capabilities and preflight creates no physical attempt", async t => {
  const original = model();
  const goal = new GoalController();
  t.after(() => goal.close());
  const wrapped = goal.wrapModel(original);
  assert.equal(wrapped.reportsAttempts, true);
  assert.equal(wrapped.capabilityVersion, undefined);
  assert.equal(wrapped.limits, undefined);
  const request = { messages: [{ role: "user", content: [{ type: "text", text: "Validate the request locally" }] }], tools: [] };
  await assert.rejects(wrapped.preflight(request, { signal: new AbortController().signal }), { name: "ModelRequestValidationError" });
  assert.ok(wrapped.capabilityVersion);
  assert.equal(wrapped.capabilityVersion, original.capabilityVersion);
  assert.deepEqual(wrapped.configuration, original.configuration);
  assert.deepEqual(wrapped.limits, { contextWindowTokens: 200, maxOutputTokens: 20 });
  for (const selected of [original, wrapped]) {
    const processor = new InMemorySpanProcessor();
    const runtime = new May({ model: selected, context: new InMemoryContext(), tracer: new BasicTracer({ processor }) });
    await assert.rejects(runtime.run({ input: "Validate the request locally" }).result, { name: "ModelRequestValidationError" });
    assert.equal(processor.getFinishedSpans().filter(span => span.name === "may.model.attempt").length, 0);
  }
});

test("active Goal preflight failure leaves model accounting complete and unreserved", async t => {
  const goal = new GoalController();
  const application = await AgentApplication.open({ model: goal.wrapModel(model()), store: new InMemorySessionStore(),
    contextFactory: goal.wrapContextFactory(new InMemoryContextFactory()),
  });
  t.after(async () => { await goal.close(); await application.close(); });
  await goal.attach(application, {
    read: async () => (await application.history()).findLast(event => event.type === "state.updated" && event.key === "verification.goal")?.value,
    write: state => application.recordState("verification.goal", state),
  });
  await goal.start("Validate model capabilities before dispatch", { maxRuns: 2, maxTotalTokens: 1000 });
  await goal.wait();
  assert.equal(goal.getGoal().status, "failed");
  assert.equal(goal.getGoal().calls.length, 0);
  assert.equal(goal.getGoal().usage.totalTokens, 0);
  assert.equal(goal.getGoal().usage.usageComplete, true);
});
