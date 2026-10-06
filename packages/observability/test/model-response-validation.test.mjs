import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ModelResponseValidationError, createModelAttemptObserver } from "@may/core";
import { BasicTracer, InMemorySpanProcessor } from "../dist/index.js";
import { OpenAIChatCompletionsModel, OpenAIResponsesModel, RetryingModel, createBuiltinProviderAdapterRegistry, createModelCapabilityResolver } from "../../providers/dist/index.js";

test("最终响应校验失败保留HTTP上报的Usage和attempt完成状态", async (t) => {
  const state = { content: "", includeUsage: true, requests: 0 };
  const server = createServer(async (incoming, outgoing) => {
    for await (const _chunk of incoming) { /* 消费实际adapter发送的请求。 */ }
    state.requests += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    if (incoming.url === "/responses") {
      outgoing.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: state.content }] }], ...(state.includeUsage ? { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } : {}) } })}\n\n`);
    } else {
      outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: state.content }, finish_reason: null }] })}\n\n`);
      outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(state.includeUsage ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } : {}) })}\n\n`);
      outgoing.end("data: [DONE]\n\n");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const responseFormat = { type: "jsonSchema", name: "value", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  const request = { messages: [{ role: "user", content: [{ type: "text", text: "Return JSON" }] }], tools: [], responseFormat };
  const registry = createBuiltinProviderAdapterRegistry({ resolver: createModelCapabilityResolver({ discoveries: [] }) });
  for (const adapter of ["openai-chat-completions", "openai-responses"]) for (const wrapped of [false, true]) for (const mode of ["schema", "json", "missing", "success"]) {
    state.content = mode === "json" ? "private-response-content[invalid" : JSON.stringify({ value: mode === "success" ? "accepted" : 7 });
    state.includeUsage = mode !== "missing";
    const raw = wrapped
      ? registry.create({ profile: "local", provider: "local", adapter, model: "local", providerConfig: { adapter, apiKey: "local-credential", baseURL }, options: {}, capabilities: { fields: { "input.text": true, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" } } } })
      : adapter === "openai-responses" ? new OpenAIResponsesModel({ apiKey: "local-credential", model: "local", baseURL }) : new OpenAIChatCompletionsModel({ apiKey: "local-credential", model: "local", baseURL });
    const model = new RetryingModel(raw, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0, shouldRetry: () => true });
    const processor = new InMemorySpanProcessor();
    const attemptObserver = createModelAttemptObserver({ tracer: new BasicTracer({ processor }), modelCallId: `${adapter}:${wrapped}:${mode}` });
    const before = state.requests;
    const received = [];
    const consume = async () => { for await (const event of model.stream(request, { signal: new AbortController().signal, attemptObserver })) received.push(event); };
    if (mode === "success") await consume();
    else await assert.rejects(consume(), (error) => {
      assert.ok(error instanceof ModelResponseValidationError);
      assert.equal(error.responseCompleted, true);
      assert.equal(error.usage?.totalTokens, state.includeUsage ? 120 : undefined);
      assert.equal(error.cost, undefined);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /private-response-content/u);
      assert.equal(received.filter((event) => event.type === "response.completed").length, 0);
      return true;
    });
    assert.equal(state.requests - before, 1);
    const attempts = processor.getFinishedSpans().filter((span) => span.name === "may.model.attempt");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, mode === "success" ? "ok" : "error");
    assert.equal(attempts[0].attributes["may.model.completed"], true);
    assert.equal(attempts[0].attributes["may.model.usage_available"], state.includeUsage);
    assert.equal(attempts[0].attributes["may.model.total_tokens"], state.includeUsage ? 120 : undefined);
    assert.doesNotMatch(JSON.stringify(attempts), /private-response-content|local-credential/u);
  }
  assert.equal(state.requests, 16);
});
