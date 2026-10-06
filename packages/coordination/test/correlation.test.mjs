import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { defineAgent } from "../../application/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";
import { BasicTracer, DiagnosticsStore } from "../../observability/dist/index.js";
import { OpenAIChatCompletionsModel } from "../../providers/openai-compatible/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore, createApplicationAgent } from "../dist/index.js";

test("parallel coordination tasks preserve trace parents through ApplicationAgent and actual HTTP model calls", { timeout: 10_000 }, async t => {
  const responses = [];
  const received = [];
  let acceptBoth;
  const both = new Promise(resolve => { acceptBoth = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    responses.push(response);
    if (responses.length === 2) acceptBoth();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const model = new OpenAIChatCompletionsModel({ apiKey: "local-protocol-test", model: "local-service", baseURL: `http://127.0.0.1:${server.address().port}` });
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ processor: diagnostics, observer: diagnostics });
  const parent = tracer.startSpan("host.coordination");
  const runtime = await CoordinationRuntime.create({ id: "correlation", store: new InMemoryCoordinationStore(),
    agents: { worker: createApplicationAgent({ version: "v1", store: new InMemorySessionStore(), definition: defineAgent({ model, tracer, permissionPolicy: () => "deny" }) }) },
    policy: { version: "v1", authorize: () => true }, tasks: [{ id: "first", agent: "worker", input: "first" }, { id: "second", agent: "worker", input: "second" }],
    limits: { maxConcurrent: 2 }, tracer, telemetry: { version: 1, parent: parent.context, schedulerExecutionId: "scheduled-execution" },
  });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const completed = runtime.wait();
  await both;
  const active = diagnostics.getDiagnostics({ traceId: parent.context.traceId }).spans;
  assert.equal(active.filter(span => span.name === "may.run" && !span.ended).length, 2);
  assert.equal(runtime.snapshot().tasks.filter(task => task.status === "running").length, 2);
  for (let index = 0; index < responses.length; index += 1) {
    const text = `completed-${index}`;
    responses[index].writeHead(200, { "content-type": "text/event-stream" });
    responses[index].end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }], usage: {
      prompt_tokens: received[index].messages.length, completion_tokens: text.length, total_tokens: received[index].messages.length + text.length,
    } })}\n\ndata: [DONE]\n\n`);
  }
  const state = await completed;
  assert.ok(state.tasks.every(task => task.status === "completed"));
  const spans = diagnostics.getDiagnostics({ traceId: parent.context.traceId }).spans;
  for (const task of state.tasks) {
    const taskSpans = diagnostics.getDiagnostics({ taskId: task.id }).spans;
    const dispatch = taskSpans.find(span => span.name === "may.coordination.dispatch");
    const run = taskSpans.find(span => span.name === "may.run");
    const modelSpan = taskSpans.find(span => span.name === "may.model.call");
    const attempt = taskSpans.find(span => span.name === "may.model.attempt");
    assert.equal(dispatch.parentSpanId, parent.context.spanId);
    assert.equal(run.parentSpanId, dispatch.context.spanId);
    assert.equal(modelSpan.parentSpanId, run.context.spanId);
    assert.equal(attempt.parentSpanId, modelSpan.context.spanId);
    assert.equal(run.attributes["may.scheduler.execution_id"], "scheduled-execution");
    assert.equal(run.attributes["may.dispatch.id"], task.dispatchId);
    assert.equal(run.attributes["may.session.id"], task.sessionId);
    assert.ok(taskSpans.every(span => span.context.traceId === parent.context.traceId && span.ended));
  }
  assert.equal(spans.filter(span => span.name === "may.model.attempt").length, 2);
  assert.equal(JSON.stringify(spans).includes("completed-"), false);
  parent.end({ status: "ok" });
});
