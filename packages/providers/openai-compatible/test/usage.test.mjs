import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { priceUsage } from "@may/core";
import { streamOpenAICompatibleResponse } from "../dist/stream.js";

test("compatible HTTP streams retain DeepSeek cache counts and audio/reasoning usage", async t => {
  const server = createServer((request, response) => {
    const invalid = request.url === "/invalid";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "completed" }, finish_reason: "stop" }], usage: {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: invalid ? -1 : 80,
      prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 10, audio_tokens: 4 },
    } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const options = { signal: new AbortController().signal, providerName: "local compatible service", requireDone: true,
    protocolError: message => new TypeError(message), finishReasonError: reason => new Error(reason) };
  const url = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  for await (const event of streamOpenAICompatibleResponse(await fetch(url), options)) events.push(event);
  const usage = events.at(-1).usage;
  assert.equal(usage.cachedReadTokens, 80);
  assert.equal(usage.reasoningTokens, 10);
  assert.deepEqual(usage.items, [{ id: "output-audio", quantity: 4, unit: "tokens", includedIn: "output" }]);
  assert.equal(priceUsage(usage, { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedReadUsdPerMillion: 0.2 }).amount, 0.000216);
  await assert.rejects(async () => {
    for await (const event of streamOpenAICompatibleResponse(await fetch(`${url}/invalid`), options)) void event;
  }, /non-negative safe integer/);
});
