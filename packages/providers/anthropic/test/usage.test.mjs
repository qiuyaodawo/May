import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { priceUsage, resolveUsageTotals } from "@may/core";
import { streamAnthropicResponse } from "../dist/stream.js";

test("Anthropic HTTP streams account for separate cache usage, cache TTLs and server tool requests", async t => {
  const server = createServer((request, response) => {
    const invalid = request.url === "/invalid";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "local-service-message", usage: { input_tokens: invalid ? -1 : 10, output_tokens: 1,
        cache_read_input_tokens: 80, cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 } } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 2 } } },
      { type: "message_stop" },
    ];
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  for await (const event of streamAnthropicResponse(await fetch(url), new AbortController().signal)) events.push(event);
  const usage = events.at(-1).usage;
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.totalTokens, 115);
  assert.equal(resolveUsageTotals(usage).totalTokens, 115);
  assert.deepEqual(usage.tokenRelations, { cachedRead: "total", cachedWrite: "total" });
  const pricing = { id: "local", version: "1", source: "host", effectiveAt: "2026-10-05T00:00:00Z", currency: "USD",
    inputPerMillion: 2, outputPerMillion: 8, cachedReadPerMillion: 0.2, cachedWritePerMillion: 3,
    items: { "cache-write-1h": { unit: "tokens", perUnit: 0.000004 }, "web-search": { unit: "requests", perUnit: 0.01 } } };
  assert.ok(Math.abs(priceUsage(usage, pricing).amount - 0.020146) < 1e-12);
  assert.equal(priceUsage(usage, pricing).complete, true);
  assert.equal(priceUsage(usage, { ...pricing, items: undefined }).complete, false);
  await assert.rejects(async () => {
    for await (const event of streamAnthropicResponse(await fetch(`${url}/invalid`), new AbortController().signal)) void event;
  }, /non-negative safe integer/);
});
