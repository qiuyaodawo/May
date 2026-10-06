import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { priceUsage } from "@may/core";
import { streamOpenAIResponse } from "../dist/stream.js";

test("Responses HTTP streams preserve cache and reasoning subsets for pricing", async t => {
  const server = createServer((request, response) => {
    const tokens = Number(new URL(request.url, "http://localhost").searchParams.get("tokens"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: {
      input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10,
      input_tokens_details: { cached_tokens: tokens / 2 }, output_tokens_details: { reasoning_tokens: 6 },
    } } })}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/?tokens=100`;
  const events = [];
  for await (const event of streamOpenAIResponse(await fetch(url), new AbortController().signal)) events.push(event);
  const usage = events.at(-1).usage;
  assert.equal(usage.cachedReadTokens, 50);
  assert.equal(usage.reasoningTokens, 6);
  assert.deepEqual(usage.tokenRelations, { cachedRead: "input", reasoning: "output" });
  assert.equal(priceUsage(usage, { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedReadUsdPerMillion: 0.2 }).amount, 0.00019);
  await assert.rejects(async () => {
    for await (const event of streamOpenAIResponse(await fetch(url.replace("100", "-2")), new AbortController().signal)) void event;
  }, /usage.input_tokens is invalid/);
});
