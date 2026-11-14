import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createDeepSeekSearchBackend,
  createWebSearchTool,
  createZhipuSearchBackend,
  WebSearchToolError,
} from "../dist/index.js";

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
        instance.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${instance.address().port}`;
}

async function execute(tool, input, signal = new AbortController().signal) {
  return tool.execute(await tool.parse(input), { signal });
}

test("web_search validates input before sending requests", async (t) => {
  let requests = 0;
  const baseURL = await server(t, (_request, response) => {
    requests++;
    response.end();
  });
  const backend = createDeepSeekSearchBackend({ apiKey: "local-server", baseURL });
  const tool = createWebSearchTool({ backend, maxResults: 3 });
  for (const input of [
    { query: "" },
    { query: " " },
    { query: "a".repeat(129) },
    { query: "test", count: 4 },
    { query: "test", count: 1.5 },
    { query: "test", extra: true },
  ]) {
    await assert.rejects(execute(tool, input));
  }
  assert.equal((await tool.parse({ query: "😀".repeat(128) })).query.length, 256);
  await assert.rejects(tool.execute({ query: "test", count: 0 }, { signal: new AbortController().signal }));
  assert.equal(requests, 0);
  assert.equal(tool.workspaceEffect, "read");
  const output = { items: [], usage: { items: [], completeness: { status: "complete" } } };
  assert.deepEqual(tool.usage(output), output.usage);
  for (const options of [{ maxResults: 51 }, { timeoutMs: 0 }, { maxResponseBytes: 0 }, { maxSummaryChars: 0 }]) {
    assert.throws(() => createWebSearchTool({ backend, ...options }), RangeError);
  }
  assert.throws(() => createZhipuSearchBackend({ apiKey: "local-server", searchEngine: "unknown" }));
});

test("web_search cancels an oversized response while the HTTP stream remains open", async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const baseURL = await server(t, (_request, response) => {
    response.on("close", closed);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(4096));
  });
  const tool = createWebSearchTool({
    backend: createDeepSeekSearchBackend({ apiKey: "local-server", baseURL }),
    maxResponseBytes: 32,
  });
  await assert.rejects(
    execute(tool, { query: "test" }),
    (error) => error instanceof WebSearchToolError && /maxResponseBytes/u.test(error.message),
  );
  await disconnected;
});

test("web_search times out and propagates caller cancellation", async (t) => {
  let started;
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const baseURL = await server(t, () => started());
  const backend = createDeepSeekSearchBackend({ apiKey: "local-server", baseURL });
  await assert.rejects(execute(createWebSearchTool({ backend, timeoutMs: 30 }), { query: "test" }), /timeoutMs/u);
  const controller = new AbortController();
  const result = execute(createWebSearchTool({ backend }), { query: "test" }, controller.signal);
  await received;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(result, /caller cancelled/u);
});

test("web_search preserves HTTP errors from a real unavailable server", async (t) => {
  const baseURL = await server(t, (_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("Service unavailable");
  });
  await assert.rejects(
    execute(createWebSearchTool({ backend: createDeepSeekSearchBackend({ apiKey: "local-server", baseURL }) }), {
      query: "test",
    }),
    (error) => error instanceof WebSearchToolError && error.status === 503,
  );
});
