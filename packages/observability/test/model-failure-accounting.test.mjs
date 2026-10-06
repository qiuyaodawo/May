import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HookExecutionError, InMemoryContext, May, ModelResponseValidationError, RUNTIME_HOOKS, runtimeHooks } from "@may/core";
import { PluginHost } from "../../plugin/dist/index.js";
import { FileSharedBudget } from "../../coordination/dist/index.js";
import { RetryingModel, createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "../../providers/dist/index.js";
import { BasicTracer, BoundedMetrics, DiagnosticsStore, InMemorySpanProcessor, alwaysOffSampler } from "../dist/index.js";

const pricing = { id: "validation-prices", version: "1", currency: "USD", source: "local-service",
  effectiveAt: "2026-10-05T00:00:00.000Z", inputPerMillion: 2, outputPerMillion: 4 };
const responseFormat = { type: "jsonSchema", name: "validation-result", schema: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
} };
const base = fileURLToPath(new URL("../dist/test-output/failed-accounting/", import.meta.url));

async function service(t, content = { value: 123, private: "private rejected body" }) {
  const state = { requests: 0 };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 接收实际 provider 请求。 */ }
    state.requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(content) }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { state, baseURL: `http://127.0.0.1:${server.address().port}` };
}

function model(baseURL) {
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  return createBuiltinProviderAdapterRegistry({ resolver }).create({ profile: "local", provider: "local", adapter: "openai-chat-completions", model: "local",
    providerConfig: { adapter: "openai-chat-completions", baseURL, apiKey: "private local credential" }, options: {}, capabilities: { fields: {
      "input.text": true, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" },
    } },
  });
}

function observation() {
  const diagnostics = new DiagnosticsStore();
  const metrics = new BoundedMetrics();
  return { diagnostics, metrics, tracer: new BasicTracer({ processor: new InMemorySpanProcessor(), observer: diagnostics, metrics, sampler: alwaysOffSampler }) };
}

async function rejectedRun(runtime) {
  const run = runtime.run({ input: "private validation input" });
  const failure = run.result.catch(error => error);
  const events = [];
  for await (const event of run.events) events.push(event);
  const error = await failure;
  assert.ok(error instanceof ModelResponseValidationError, error);
  assert.equal(error.responseCompleted, true);
  assert.equal(error.usage.totalTokens, 5);
  assert.ok(!events.some(event => ["model.completed", "step.completed", "run.completed"].includes(event.type)));
  assert.ok(events.some(event => event.type === "run.failed"));
  return { error, events };
}

function assertAccounting(observed, amount) {
  const spans = observed.diagnostics.getDiagnostics().spans;
  const call = spans.find(span => span.name === "may.model.call");
  const attempt = spans.find(span => span.name === "may.model.attempt");
  const run = spans.find(span => span.name === "may.run");
  for (const span of [attempt, call]) {
    assert.equal(span.status, "error");
    assert.equal(span.attributes["may.model.usage_available"], true);
    assert.equal(span.attributes["may.model.completed"], true);
    assert.equal(span.attributes["may.model.total_tokens"], 5);
    assert.equal(span.attributes["may.model.usage_complete"], true);
  }
  assert.equal(call.attributes["may.model.cost"], amount);
  assert.equal(call.attributes["may.model.cost_complete"], true);
  assert.equal(run.attributes["may.run.total_tokens"], 5);
  assert.equal(run.attributes["may.run.usage_complete"], true);
  assert.equal(run.attributes["may.run.cost_usd"], amount);
  assert.equal(run.attributes["may.run.cost_complete"], true);
  assert.equal(run.status, "error");
  assert.ok(spans.every(span => span.ended));
  assert.equal(observed.metrics.getMetrics().find(metric => metric.name === "may.model.total_tokens").value, 5);
  assert.equal(observed.metrics.getMetrics().find(metric => metric.name === "may.model.cost").value, amount);
  assert.ok(observed.metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
  assert.ok(!JSON.stringify(spans).includes("private rejected body"));
  assert.ok(!JSON.stringify(spans).includes("private local credential"));
  return { call, attempt, run };
}

test("schema-invalid final usage is charged once and remains visible in attempt, call and failed Run", async t => {
  const local = await service(t);
  for (const retry of [false, true]) {
    const observed = observation();
    const context = new InMemoryContext();
    const selected = model(local.baseURL);
    await rejectedRun(new May({ context, model: retry ? new RetryingModel(selected) : selected, tracer: observed.tracer, responseFormat, runBudget: { pricing } }));
    assertAccounting(observed, 0.000016);
    assert.ok((await context.snapshot()).messages.every(message => message.role === "user"));
  }
  assert.equal(local.state.requests, 2);
});

test("successful actual HTTP usage completeness agrees across attempt, call, Run and budget", async t => {
  const local = await service(t, { value: "accepted" });
  for (const retry of [false, true]) {
    const observed = observation();
    const selected = model(local.baseURL);
    const run = new May({ context: new InMemoryContext(), model: retry ? new RetryingModel(selected) : selected,
      tracer: observed.tracer, responseFormat, runBudget: { pricing } }).run({ input: "Validate usage" });
    const result = await run.result;
    assert.equal(result.budget.usageComplete, true);
    assert.equal(result.budget.totalTokens, 5);
    for (const span of observed.diagnostics.getDiagnostics().spans.filter(span => ["may.model.attempt", "may.model.call", "may.run"].includes(span.name))) {
      const prefix = span.name === "may.run" ? "may.run" : "may.model";
      assert.equal(span.attributes[`${prefix}.usage_complete`], result.budget.usageComplete);
      assert.equal(span.attributes[`${prefix}.total_tokens`], result.budget.totalTokens);
      assert.equal(span.status, "ok");
    }
  }
  assert.equal(local.state.requests, 2);
});

test("a real final modelEvent Hook failure preserves received usage without storing the assistant response", async t => {
  const local = await service(t, { value: "accepted" });
  const host = await PluginHost.create({ hooks: RUNTIME_HOOKS, plugins: [{ id: "validate-delivery", version: "1.0.0",
    setup(context) { context.on(runtimeHooks.modelEvent, event => { if (event.type === "response.completed") throw new Error("Delivery Hook unavailable"); }); },
  }] });
  t.after(() => host.close());
  const hooks = await host.createScope("application", { id: "validation-hook" });
  for (const retry of [false, true]) {
    const observed = observation();
    const context = new InMemoryContext();
    const selected = model(local.baseURL);
    const { error } = await rejectedRun(new May({ context, hooks, model: retry ? new RetryingModel(selected) : selected,
      tracer: observed.tracer, responseFormat, runBudget: { pricing } }));
    assert.equal(error.cause.hookName, "model.event");
    assert.equal(error.cause.cause.message, "Delivery Hook unavailable");
    assertAccounting(observed, 0.000016);
    assert.ok((await context.snapshot()).messages.every(message => message.role === "user"));
  }
  assert.equal(local.state.requests, 2);
});

test("a real modelAfter Hook failure keeps completed response usage and pricing charged once", async t => {
  const local = await service(t, { value: "accepted" });
  const host = await PluginHost.create({ hooks: RUNTIME_HOOKS, plugins: [{ id: "validate-result", version: "1.0.0",
    setup(context) { context.on(runtimeHooks.modelAfter, () => { throw new Error("Result Hook unavailable"); }); },
  }] });
  t.after(() => host.close());
  const hooks = await host.createScope("application", { id: "result-hook" });
  const observed = observation();
  let priced = 0;
  const run = new May({ context: new InMemoryContext(), hooks, model: new RetryingModel(model(local.baseURL)),
    tracer: observed.tracer, responseFormat, runBudget: { usagePricer(usage) {
      priced += 1;
      assert.equal(usage.totalTokens, 5);
      return { amount: 0.01, currency: "USD", kind: "estimated", complete: true, missingReasons: [] };
    } } }).run({ input: "Validate result Hook" });
  const failure = run.result.catch(error => error);
  const events = [];
  for await (const event of run.events) events.push(event);
  const error = await failure;
  assert.ok(error instanceof HookExecutionError);
  assert.equal(error.hookName, "model.after");
  assert.equal(priced, 1);
  const spans = observed.diagnostics.getDiagnostics().spans;
  const call = spans.find(span => span.name === "may.model.call");
  const failedRun = spans.find(span => span.name === "may.run");
  assert.equal(call.status, "ok");
  assert.equal(call.attributes["may.model.total_tokens"], 5);
  assert.equal(call.attributes["may.model.cost"], 0.01);
  assert.equal(failedRun.status, "error");
  assert.equal(failedRun.attributes["may.run.total_tokens"], 5);
  assert.equal(failedRun.attributes["may.run.cost_usd"], 0.01);
  assert.equal(failedRun.attributes["may.run.usage_complete"], true);
  assert.equal(observed.metrics.getMetrics().find(metric => metric.name === "may.model.total_tokens").value, 5);
  assert.equal(observed.metrics.getMetrics().find(metric => metric.name === "may.model.cost").value, 0.01);
  assert.ok(spans.every(span => span.ended));
  assert.ok(observed.metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
  assert.ok(events.some(event => event.type === "run.failed"));
  assert.ok(!events.some(event => event.type === "run.completed"));
  assert.equal(local.state.requests, 1);
});

test("shared failure settlement reuses one custom pricing receipt in the Run and telemetry", async t => {
  const local = await service(t);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "shared-"));
  let priced = 0;
  const usagePricer = (usage, schedule) => {
    priced += 1;
    assert.equal(usage.totalTokens, 5);
    assert.equal(schedule.version, "1");
    return { amount: priced / 100, currency: "USD", kind: "estimated", complete: true, missingReasons: [] };
  };
  const shared = await FileSharedBudget.open(directory, "validation", { maxModelCalls: 2, maxCostUsd: 1, pricing }, { usagePricer });
  t.after(async () => {
    await shared.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const selected = new RetryingModel(shared.wrapModel(model(local.baseURL), { reservation: { totalTokens: 10, costUsd: 0.1 } }));
  const observed = observation();
  const context = new InMemoryContext();
  await rejectedRun(new May({ context, model: selected, tracer: observed.tracer, responseFormat, runBudget: { pricing, usagePricer, maxCostUsd: 1 } }));
  assert.equal(priced, 1);
  assert.equal(local.state.requests, 1);
  const snapshot = await shared.snapshot();
  assert.equal(snapshot.calls.length, 1);
  assert.equal(snapshot.calls[0].status, "settled");
  assert.equal(snapshot.calls[0].totalTokens, 5);
  assert.equal(snapshot.calls[0].cost.amount, 0.01);
  assert.equal((await shared.totals()).blocked, false);
  const { call } = assertAccounting(observed, 0.01);
  assert.equal(call.attributes["may.model.pricing_version"], "1");
  assert.ok((await context.snapshot()).messages.every(message => message.role === "user"));
});

test("validation and budget-limit failures preserve charged usage and both error causes", async t => {
  const local = await service(t);
  const observed = observation();
  const { error, events } = await rejectedRun(new May({ context: new InMemoryContext(), model: new RetryingModel(model(local.baseURL)), tracer: observed.tracer,
    responseFormat, runBudget: { maxTotalTokens: 4, pricing } }));
  assert.ok(error.cause instanceof AggregateError);
  assert.ok(error.cause.errors[0] instanceof ModelResponseValidationError);
  assert.equal(error.cause.errors[1].dimension, "totalTokens");
  assert.equal(events.filter(event => event.type === "run.budget.exceeded").length, 1);
  assertAccounting(observed, 0.000016);
  assert.equal(local.state.requests, 1);
});

test("pricing failures retain known tokens, unavailable cost and the original validation cause", async t => {
  const local = await service(t);
  const observed = observation();
  let priced = 0;
  const { error } = await rejectedRun(new May({ context: new InMemoryContext(), model: model(local.baseURL), tracer: observed.tracer, responseFormat,
    runBudget: { usagePricer() { priced += 1; throw new Error("Pricing service unavailable"); } } }));
  assert.equal(priced, 1);
  assert.ok(error.cause instanceof AggregateError);
  assert.ok(error.cause.errors[0] instanceof ModelResponseValidationError);
  assert.equal(error.cause.errors[1].message, "Pricing service unavailable");
  const spans = observed.diagnostics.getDiagnostics().spans;
  const call = spans.find(span => span.name === "may.model.call");
  const run = spans.find(span => span.name === "may.run");
  assert.equal(call.attributes["may.model.total_tokens"], 5);
  assert.equal(call.attributes["may.model.cost"], undefined);
  assert.equal(call.attributes["may.model.cost_complete"], false);
  assert.equal(run.attributes["may.run.total_tokens"], 5);
  assert.equal(run.attributes["may.run.cost_complete"], false);
  assert.ok(spans.every(span => span.ended));
  assert.ok(observed.metrics.getMetrics().filter(metric => metric.name.endsWith(".active")).every(metric => metric.value === 0));
  assert.equal(local.state.requests, 1);
});
