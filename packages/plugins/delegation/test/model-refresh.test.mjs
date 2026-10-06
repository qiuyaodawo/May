import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "../../../providers/dist/index.js";
import { FileSharedBudget } from "../../../coordination/dist/index.js";
import { SubagentRequestLedger, withRequestBudget } from "../dist/subagent-budget.js";

const request = { messages: [{ role: "user", content: [{ type: "text", text: "Budget capability refresh" }] }], tools: [] };

test("actual HTTP capability preflight updates both budget wrappers without reserving a model call", { timeout: 10_000 }, async t => {
  const base = fileURLToPath(new URL("../../../../review/budget-model-refresh/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "http-"));
  const state = { contextWindowTokens: 200, maxOutputTokens: 20, text: true, metadataRequests: 0, modelRequests: 0 };
  const service = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/v1/capabilities") {
      state.metadataRequests += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ contextWindowTokens: { status: "known", source: "provider", value: state.contextWindowTokens },
        maxOutputTokens: { status: "known", source: "provider", value: state.maxOutputTokens },
        "input.text": { status: state.text ? "known" : "unsupported", source: "provider", value: state.text } }));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "local-budget-model");
    state.modelRequests += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "completed file budget request" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const baseURL = `http://127.0.0.1:${service.address().port}/v1`;
  for (const kind of ["shared", "request"]) {
    state.contextWindowTokens = 200;
    state.maxOutputTokens = 20;
    state.text = true;
    const resolver = createModelCapabilityResolver({ discoveries: [{ name: "budget-http-metadata", async discoverCapabilities(selection) {
      const response = await fetch(`${selection.providerConfig.baseURL}/capabilities`);
      assert.equal(response.status, 200);
      return response.json();
    } }] });
    const model = createBuiltinProviderAdapterRegistry({ resolver }).create({ profile: "local-budget", provider: "local-budget", adapter: "openai-chat-completions",
      model: "local-budget-model", providerConfig: { adapter: "openai-chat-completions", apiKey: "local-budget-service", baseURL }, options: {} });
    const ledger = kind === "shared"
      ? await FileSharedBudget.open(directory, "shared", { maxModelCalls: 4, maxTotalTokens: 100 })
      : await SubagentRequestLedger.open(directory, "request", { maxModelCalls: 4, maxTotalTokens: 100, reservationTokens: 10 });
    try {
      const wrapped = kind === "shared" ? ledger.wrapModel(model, { reservation: { totalTokens: 10 } }) : withRequestBudget(model, () => ledger);
      assert.equal(wrapped.capabilityVersion, undefined);
      assert.equal(wrapped.limits, undefined);
      assert.equal(wrapped.configuration.capabilityVersion, undefined);
      const options = { signal: new AbortController().signal, modelCallId: `${kind}-call` };
      const initialRequests = state.modelRequests;
      await wrapped.preflight(request, options);
      assert.ok(wrapped.capabilityVersion);
      const initialVersion = wrapped.capabilityVersion;
      assert.deepEqual(wrapped.limits, { contextWindowTokens: 200, maxOutputTokens: 20 });
      assert.deepEqual(wrapped.configuration, model.configuration);
      assert.equal(wrapped.reportsAttempts, model.reportsAttempts);
      assert.equal(wrapped.configuration.capabilityVersion, initialVersion);
      assert.equal((await ledger.snapshot()).calls.length, 0);
      assert.equal(state.modelRequests, initialRequests);
      state.contextWindowTokens = 100;
      state.maxOutputTokens = 10;
      await model.refreshCapabilities();
      assert.notEqual(wrapped.capabilityVersion, initialVersion);
      assert.deepEqual(wrapped.limits, { contextWindowTokens: 100, maxOutputTokens: 10 });
      assert.equal(wrapped.configuration.capabilityVersion, model.capabilityVersion);
      assert.equal((await ledger.snapshot()).calls.length, 0);
      for await (const event of wrapped.stream(request, options)) if (event.type === "response.completed") assert.equal(event.usage.totalTokens, 5);
      assert.equal(state.modelRequests, initialRequests + 1);
      assert.equal((await ledger.snapshot()).calls.length, 1);
      assert.equal((await ledger.totals()).totalTokens, 5);
      state.text = false;
      await model.refreshCapabilities();
      await assert.rejects(wrapped.preflight(request, options), /input.text is unsupported/);
      assert.equal((await ledger.snapshot()).calls.length, 1);
      assert.equal(state.modelRequests, initialRequests + 1);
    } finally { await ledger.close(); }
  }
  assert.equal(state.metadataRequests, 6);
  assert.equal(state.modelRequests, 2);
});
