import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { defineAgent } from "../../application/dist/index.js";
import { OpenAIChatCompletionsModel } from "../../providers/openai-compatible/dist/index.js";
import { BasicTracer, DiagnosticsStore } from "../../observability/dist/index.js";
import { InMemorySessionStore } from "../dist/index.js";

test("reopened Session continuation creates a fresh Run and references durable previous Run identity", async t => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ observer: diagnostics, processor: diagnostics });
  const definition = defineAgent({
    model: new OpenAIChatCompletionsModel({ model: "local-service", apiKey: "local-protocol-test", baseURL: `http://127.0.0.1:${server.address().port}` }),
    tracer, permissionPolicy: () => "deny",
  });
  const store = new InMemorySessionStore();
  const application = await definition.open({ store });
  const first = await application.submit({ input: "继续执行测试" });
  await first.result;
  const sessionId = application.sessionId;
  await application.close();
  const reopened = await definition.open({ store, sessionId, resume: true });
  t.after(() => reopened.close());
  const continuation = await reopened.continue();
  await continuation.result;
  assert.notEqual(first.id, continuation.id);
  assert.equal(calls, 2);
  const runSpan = diagnostics.getDiagnostics({ sessionId, runId: continuation.id }).spans.find(span => span.name === "may.run");
  assert.equal(runSpan.attributes["may.run.resumed_from"], first.id);
  assert.equal(runSpan.attributes["may.run.continuation"], true);
  assert.notEqual(runSpan.context.traceId, first.traceContext.traceId);
});
