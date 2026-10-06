import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelResponseValidationError, priceUsage, resolveRunBudget, RunBudgetMeter } from "@may/core";
import { OpenAIChatCompletionsModel, createCapabilityValidatedModel, createModelCapabilityResolver } from "../../../providers/dist/index.js";
import { FileSharedBudget } from "../../../coordination/dist/index.js";
import { SubagentRequestLedger, withRequestBudget } from "../dist/subagent-budget.js";

const pricing = { id: "invalid-response-prices", version: "1", currency: "USD", source: "host", effectiveAt: "2026-10-05T00:00:00Z", inputPerMillion: 2, outputPerMillion: 8 };
const request = { messages: [{ role: "user", content: [{ type: "text", text: "Return a string value" }] }], tools: [], responseFormat: {
  type: "jsonSchema", name: "string-value", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, strict: true,
} };
async function collect(model, id, modelRequest = request) { for await (const event of model.stream(modelRequest, { signal: new AbortController().signal, modelCallId: id })) assert.notEqual(event.type, "response.completed"); }

async function service(t, includeUsage = true, toolCalls = false) {
  let requests = 0;
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.response_format.type, "json_schema");
    requests += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolCalls ? { tool_calls: Array.from({ length: 2 }, (_, index) => ({ index, id: `call-${index}`, type: "function", function: { name: "echo", arguments: JSON.stringify({ value: "actual HTTP tool response" }) } })) }
      : { content: JSON.stringify({ value: requests }) };
    outgoing.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: toolCalls ? "tool_calls" : "stop" }],
      ...(includeUsage ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}) })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { get requests() { return requests; }, model: () => new OpenAIChatCompletionsModel({ apiKey: "local-response-budget", model: "schema-budget",
    baseURL: `http://127.0.0.1:${server.address().port}` }) };
}
async function directory(t) {
  const base = fileURLToPath(new URL("../../../../review/invalid-response-budgets/", import.meta.url));
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "http-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("shared budget settles schema-invalid final usage and forwards its single custom pricing receipt", async t => {
  const endpoint = await service(t), path = await directory(t);
  let prices = 0;
  const usagePricer = (usage, rates) => { prices += 1; return priceUsage(usage, rates); };
  const ledger = await FileSharedBudget.open(path, "priced-schema", { maxModelCalls: 4, maxTotalTokens: 100, maxCostUsd: 1, pricing }, { usagePricer });
  try {
    const wrapped = ledger.wrapModel(endpoint.model(), { reservation: { totalTokens: 10, costUsd: 0.1 } });
    let failure;
    await assert.rejects(collect(wrapped, "priced-call"), error => { failure = error; return error instanceof ModelResponseValidationError; });
    assert.equal(failure.responseCompleted, true);
    assert.deepEqual(failure.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.calls[0].status, "settled");
    assert.deepEqual(snapshot.calls[0].cost, failure.cost);
    const meter = new RunBudgetMeter(resolveRunBudget({ maxCostUsd: 1, pricing, usagePricer }));
    meter.recordUsage(failure.usage, failure.cost);
    assert.equal(meter.snapshot().costUsd, (await ledger.totals()).costUsd);
    assert.equal(prices, 1);
    assert.equal(endpoint.requests, 1);
  } finally { await ledger.close(); }
});

test("request budget settles schema-invalid final and an unpriced ledger preserves host pricing", async t => {
  const endpoint = await service(t), path = await directory(t);
  for (const priced of [true, false]) {
    const ledger = await SubagentRequestLedger.open(path, `request-${priced}`, { maxModelCalls: 4, maxTotalTokens: 100, reservationTokens: 10,
      ...(priced ? { pricing } : {}) });
    try {
      let failure;
      await assert.rejects(collect(withRequestBudget(endpoint.model(), () => ledger), `request-call-${priced}`), error => {
        failure = error; return error instanceof ModelResponseValidationError;
      });
      const snapshot = await ledger.snapshot();
      assert.equal(snapshot.calls[0].status, "settled");
      assert.equal(snapshot.calls[0].totalTokens, 5);
      assert.equal((await ledger.totals()).usageComplete, true);
      if (priced) assert.deepEqual(failure.cost, snapshot.calls[0].cost);
      else assert.equal(failure.cost, undefined);
      const meter = new RunBudgetMeter(resolveRunBudget({ maxCostUsd: 1, pricing }));
      meter.recordUsage(failure.usage, failure.cost);
      assert.equal(meter.snapshot().costComplete, true);
      assert.equal(meter.snapshot().costUsd, 0.000028);
    } finally { await ledger.close(); }
  }
  assert.equal(endpoint.requests, 2);
});

test("a schema-invalid final preserves the schema cause when a settled receipt exceeds its reservation", async t => {
  const endpoint = await service(t), path = await directory(t);
  const ledger = await FileSharedBudget.open(path, "exceeded-schema", { maxModelCalls: 4, maxTotalTokens: 100, pricing });
  try {
    let failure;
    await assert.rejects(collect(ledger.wrapModel(endpoint.model(), { reservation: { totalTokens: 3 } }), "exceeded-call"), error => {
      failure = error; return error instanceof ModelResponseValidationError;
    });
    assert.match(failure.message, /does not satisfy responseFormat.schema/);
    assert.ok(failure.cause instanceof AggregateError);
    assert.ok(failure.cause.errors[0] instanceof ModelResponseValidationError);
    assert.match(failure.cause.errors[1].message, /Shared budget exceeded/);
    assert.equal((await ledger.snapshot()).calls[0].status, "settled");
    assert.equal((await ledger.totals()).totalTokens, 5);
    assert.equal((await ledger.totals()).blocked, true);
    assert.equal(failure.cost.complete, true);
  } finally { await ledger.close(); }
});

test("schema-invalid finals without usage keep the real provider call unknown", async t => {
  const endpoint = await service(t, false), path = await directory(t);
  const ledger = await FileSharedBudget.open(path, "missing-schema-usage", { maxModelCalls: 4, maxTotalTokens: 100, pricing });
  try {
    await assert.rejects(collect(ledger.wrapModel(endpoint.model(), { reservation: { totalTokens: 10 } }), "missing-call"), ModelResponseValidationError);
    assert.equal((await ledger.snapshot()).calls[0].status, "unknown");
    assert.equal((await ledger.totals()).totalTokens, 10);
    assert.equal((await ledger.totals()).blocked, true);
    assert.equal(endpoint.requests, 1);
  } finally { await ledger.close(); }
});

test("validation after inner settlement preserves both receipts without repricing or marking known usage unknown", async t => {
  const endpoint = await service(t, true, true), path = await directory(t);
  let prices = 0;
  const usagePricer = (usage, rates) => { prices += 1; return priceUsage(usage, rates); };
  const shared = await FileSharedBudget.open(path, "inner-settled", { maxModelCalls: 4, maxTotalTokens: 100, pricing }, { usagePricer });
  const requestLedger = await SubagentRequestLedger.open(path, "outer-settled", { maxModelCalls: 4, maxTotalTokens: 100, reservationTokens: 10, pricing });
  try {
    const metered = shared.wrapModel(endpoint.model(), { reservation: { totalTokens: 10 } });
    const validated = createCapabilityValidatedModel(metered, { profile: "local-tools", provider: "local-tools", adapter: "openai-chat-completions", model: "schema-budget",
      providerConfig: { adapter: "openai-chat-completions", capabilities: { fields: { "tools.maxCalls": 1 } } }, options: {}, capabilities: { fields: {
        "input.text": true, tools: true, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" },
      } } }, { resolver: createModelCapabilityResolver({ discoveries: [] }) });
    const toolRequest = { ...request, tools: [{ name: "echo", description: "Return a supplied value", inputSchema: request.responseFormat.schema }] };
    let failure;
    await assert.rejects(collect(withRequestBudget(validated, () => requestLedger), "known-call", toolRequest), error => {
      failure = error; return error instanceof ModelResponseValidationError;
    });
    assert.match(failure.message, /exceeds tools.maxCalls/);
    const inner = (await shared.snapshot()).calls, outer = (await requestLedger.snapshot()).calls;
    assert.equal(inner.length, 1);
    assert.equal(outer.length, 1);
    assert.equal(inner[0].status, "settled");
    assert.equal(outer[0].status, "settled");
    assert.deepEqual(inner[0].cost, outer[0].cost);
    assert.deepEqual(failure.cost, inner[0].cost);
    assert.equal(prices, 1);
    assert.equal(endpoint.requests, 1);
  } finally { await requestLedger.close(); await shared.close(); }
});
