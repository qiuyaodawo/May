import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { InMemoryContext, May } from "@may/core";
import { BasicTracer, InMemorySpanProcessor } from "../dist/index.js";
import { RetryingModel, createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "../../providers/dist/index.js";

test("preflight拒绝请求时没有HTTP请求和物理attempt记录", async (t) => {
  const requests = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ value: "accepted" }) }, finish_reason: null }] })}\n\n`);
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`);
    outgoing.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const registry = createBuiltinProviderAdapterRegistry({ resolver });
  const selection = { profile: "local", provider: "local", adapter: "openai-chat-completions", model: "local", providerConfig: { adapter: "openai-chat-completions", apiKey: "local-credential", baseURL: `http://127.0.0.1:${server.address().port}` }, options: {}, capabilities: { fields: { "input.text": false } } };
  for (const model of [registry.create(selection), new RetryingModel(registry.create(selection), { jitterRatio: 0 })]) {
    const processor = new InMemorySpanProcessor();
    const runtime = new May({ context: new InMemoryContext(), model, tracer: new BasicTracer({ processor }) });
    await assert.rejects(runtime.run({ input: "preflight input" }).result, /input.text is unsupported/);
    const spans = processor.getFinishedSpans();
    assert.equal(spans.filter((span) => span.name === "may.model.attempt").length, 0);
    assert.equal(spans.find((span) => span.name === "may.model.call").attributes["may.model.attempts"], 0);
  }
  assert.equal(requests.length, 0);
  assert.equal(resolver.verificationRecords(selection).length, 0);

  const responseFormat = { type: "jsonSchema", name: "accepted", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  const acceptedSelection = { ...selection, options: { responseFormat }, capabilities: { fields: { "input.text": true, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" } } } };
  const model = registry.create(acceptedSelection);
  const request = Object.freeze({ messages: [{ role: "user", content: [{ type: "text", text: "JSON input" }] }], tools: [] });
  await model.preflight(request, { signal: new AbortController().signal });
  assert.equal(request.responseFormat, undefined);
  assert.equal(requests.length, 0);
  assert.ok(model.capabilityVersion);
  assert.equal(model.lastValidation.status, "valid");
  const processor = new InMemorySpanProcessor();
  await new May({ context: new InMemoryContext(), model: new RetryingModel(model, { jitterRatio: 0 }), tracer: new BasicTracer({ processor }) }).run({ input: "JSON input" }).result;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].response_format.type, "json_schema");
  assert.equal(processor.getFinishedSpans().filter((span) => span.name === "may.model.attempt").length, 1);
  assert.equal(resolver.verificationRecords(acceptedSelection).find((record) => record.capability === "structuredOutput.jsonSchema").evidence, "response-validated");
});
