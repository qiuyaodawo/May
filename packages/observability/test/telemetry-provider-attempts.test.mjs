import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryContext, May, createModelAttemptObserver } from "@sortedyuan/may/core";
import {
  BasicTracer,
  BoundedMetrics,
  DiagnosticsStore,
  InMemorySpanProcessor,
  alwaysOffSampler,
} from "../dist/index.js";
import {
  RetryingModel,
  createBuiltinProviderAdapterRegistry,
  createModelCapabilityResolver,
} from "../../providers/dist/index.js";
import { OpenAIChatCompletionsModel } from "@sortedyuan/providers/openai-compatible";
import {
  localTelemetrySelection,
  startLocalTelemetryService,
} from "../../providers/test/fixtures/local-telemetry-service.mjs";

test("actual provider retries have independent attempt spans and first output timings", async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 请求由实际 adapter 发送。 */
    }
    requests += 1;
    if (requests === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unavailable", type: "server_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "private reasoning" }, finish_reason: null }] })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "private answer" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const processor = new InMemorySpanProcessor();
  const metrics = new BoundedMetrics();
  const tracer = new BasicTracer({ processor, metrics });
  const model = new RetryingModel(
    new OpenAIChatCompletionsModel({
      apiKey: "local-test",
      model: "local",
      baseURL: `http://127.0.0.1:${server.address().port}`,
    }),
    { baseDelayMs: 20, maxDelayMs: 20, jitterRatio: 0 },
  );
  const runtime = new May({ context: new InMemoryContext(), model, tracer });
  await runtime.run({ input: "private prompt" }).result;
  const spans = processor.getFinishedSpans();
  const attempts = spans.filter((span) => span.name === "may.model.attempt");
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((span) => span.status),
    ["error", "ok"],
  );
  assert.equal(attempts[0].attributes["may.model.first_content_ms"], undefined);
  assert.ok(attempts[1].attributes["may.model.first_text_ms"] >= attempts[1].attributes["may.model.first_content_ms"]);
  const call = spans.find((span) => span.name === "may.model.call");
  assert.ok(call.attributes["may.model.first_text_ms"] >= 20);
  assert.equal(call.attributes["may.model.attempts"], 2);
  assert.ok(attempts.every((span) => span.parentSpanId === call.context.spanId));
  assert.equal(metrics.getMetrics().find((metric) => metric.name === "may.model.retries").value, 1);
  assert.ok(call.attributes["may.model.retry_wait_ms"] >= 15);
  assert.equal(
    metrics.getMetrics().find((metric) => metric.name === "may.model.retry_wait").sum,
    call.attributes["may.model.retry_wait_ms"],
  );
  assert.doesNotMatch(JSON.stringify(spans), /private prompt|private answer|private reasoning|local-test/);
});

test("real provider attempt metrics retain distinct provider and model labels with sampling disabled", async (t) => {
  const service = await startLocalTelemetryService(t);
  const metrics = new BoundedMetrics();
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({
    processor: new InMemorySpanProcessor(),
    metrics,
    observer: diagnostics,
    sampler: alwaysOffSampler,
  });
  const registry = createBuiltinProviderAdapterRegistry({
    resolver: createModelCapabilityResolver({ discoveries: [] }),
  });
  for (const identity of ["one", "two"]) {
    const selection = {
      ...localTelemetrySelection(service.baseURL),
      provider: `provider-${identity}`,
      model: `model-${identity}`,
      profile: `profile-${identity}`,
    };
    const model = new RetryingModel(registry.create(selection));
    await new May({ context: new InMemoryContext(), model, tracer }).run({ input: "private query" }).result;
  }
  assert.equal(service.state.requests.length, 2);
  const attempts = metrics.getMetrics().filter((metric) => metric.name === "may.model.attempt.count");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((metric) => metric.attributes["may.model.provider"]).sort(), [
    "provider-one",
    "provider-two",
  ]);
  assert.deepEqual(attempts.map((metric) => metric.attributes["may.model.name"]).sort(), ["model-one", "model-two"]);
  assert.ok(
    attempts.every(
      (metric) => metric.value === 1 && metric.attributes["may.model.adapter"] === "openai-chat-completions",
    ),
  );
  assert.ok(
    metrics
      .getMetrics()
      .filter((metric) => metric.name.endsWith(".active"))
      .every((metric) => metric.value === 0),
  );
  assert.ok(
    diagnostics
      .getDiagnostics()
      .spans.filter((span) => span.name === "may.model.attempt")
      .every(
        (span) =>
          typeof span.attributes["may.run.id"] === "string" &&
          span.attributes["may.step"] === 1 &&
          span.sampled === false,
      ),
  );
});

test("cancelled retry waits report actual elapsed waiting without a second physical attempt", async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收实际 adapter 请求。 */
    }
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Unavailable", type: "server_error" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const diagnostics = new DiagnosticsStore();
  const metrics = new BoundedMetrics();
  const model = new RetryingModel(
    new OpenAIChatCompletionsModel({
      apiKey: "local-test",
      model: "local",
      baseURL: `http://127.0.0.1:${server.address().port}`,
    }),
    { baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
  );
  const started = performance.now();
  const run = new May({
    context: new InMemoryContext(),
    model,
    tracer: new BasicTracer({
      processor: new InMemorySpanProcessor(),
      observer: diagnostics,
      metrics,
      sampler: alwaysOffSampler,
    }),
  }).run({ input: "query" });
  const rejected = assert.rejects(run.result);
  for await (const event of run.events)
    if (event.type === "model.retrying") {
      await delay(20);
      run.cancel();
      break;
    }
  await rejected;
  const elapsed = performance.now() - started;
  assert.equal(requests, 1);
  const call = diagnostics.getDiagnostics().spans.find((span) => span.name === "may.model.call");
  assert.equal(call.status, "cancelled");
  assert.equal(call.attributes["may.model.attempts"], 1);
  assert.ok(call.attributes["may.model.retry_wait_ms"] > 0);
  assert.ok(call.attributes["may.model.retry_wait_ms"] <= call.durationMs);
  assert.ok(call.durationMs <= elapsed);
  assert.equal(
    metrics.getMetrics().find((metric) => metric.name === "may.model.retry_wait").sum,
    call.attributes["may.model.retry_wait_ms"],
  );
  assert.ok(
    metrics
      .getMetrics()
      .filter((metric) => metric.name.endsWith(".active"))
      .every((metric) => metric.value === 0),
  );
});

test("actual tool-only response records first content with absent first text", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收真实模型请求。 */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-local", type: "function", function: { name: "inspect", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
    );
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const processor = new InMemorySpanProcessor();
  const model = new RetryingModel(
    new OpenAIChatCompletionsModel({
      apiKey: "local-test",
      model: "local",
      baseURL: `http://127.0.0.1:${server.address().port}`,
    }),
  );
  const observer = createModelAttemptObserver({ tracer: new BasicTracer({ processor }), modelCallId: "tool-only" });
  for await (const _event of model.stream(
    { messages: [], tools: [] },
    { signal: new AbortController().signal, attemptObserver: observer },
  )) {
    /* 消费实际 adapter stream。 */
  }
  const attempt = processor.getFinishedSpans()[0];
  assert.equal(attempt.status, "ok");
  assert.equal(attempt.attributes["may.model.has_content"], true);
  assert.equal(attempt.attributes["may.model.has_text"], false);
  assert.equal(typeof attempt.attributes["may.model.first_content_ms"], "number");
  assert.equal(attempt.attributes["may.model.first_text_ms"], undefined);
});

test("actual provider cancellation and incomplete response retain attempt outcomes", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 接收真实模型请求。 */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (request.url === "/incomplete/chat/completions") {
      response.end("data: [DONE]\n\n");
      return;
    }
    const timer = setTimeout(() => response.end(), 200);
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const mode of ["incomplete", "cancel"]) {
    const processor = new InMemorySpanProcessor();
    const model = new RetryingModel(
      new OpenAIChatCompletionsModel({
        apiKey: "local-test",
        model: "local",
        baseURL: `http://127.0.0.1:${server.address().port}/${mode}`,
      }),
    );
    const runtime = new May({ context: new InMemoryContext(), model, tracer: new BasicTracer({ processor }) });
    const run = runtime.run({ input: "query" });
    const timer = mode === "cancel" ? setTimeout(() => run.cancel(), 25) : undefined;
    try {
      await assert.rejects(run.result);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const attempt = processor.getFinishedSpans().find((span) => span.name === "may.model.attempt");
    assert.equal(attempt.status, mode === "cancel" ? "cancelled" : "error");
    assert.equal(attempt.attributes["may.model.has_content"], false);
    assert.equal(attempt.attributes["may.model.first_content_ms"], undefined);
    assert.equal(attempt.attributes["may.model.usage_available"], false);
  }
});
