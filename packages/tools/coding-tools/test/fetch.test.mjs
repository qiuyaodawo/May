import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createFetchTool } from "../dist/fetch.js";

async function execute(tool, url, signal = new AbortController().signal) {
  return tool.execute(await tool.parse({ url }), { signal });
}

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

test("fetch requires explicit local access and converts HTML", async (t) => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Hello</h1><script>secret()</script><p>World</p>");
  });
  await assert.rejects(execute(createFetchTool({}), origin), /address is not public/);
  const result = await execute(createFetchTool({ allowedOrigins: [origin] }), origin);
  assert.match(result.text, /HELLO/u);
  assert.match(result.text, /World/u);
  assert.doesNotMatch(result.text, /secret/u);
  assert.equal(result.truncated, false);
});

test("fetch checks every redirect origin and enforces redirect limits", async (t) => {
  const target = await server(t, (_request, response) => response.end("private"));
  const origin = await server(t, (request, response) => {
    response.writeHead(302, { location: request.url === "/loop" ? "/loop" : target });
    response.end();
  });
  await assert.rejects(execute(createFetchTool({ allowedOrigins: [origin] }), origin), /origin is not allowed/);
  await assert.rejects(
    execute(createFetchTool({ allowedOrigins: [origin], maxRedirects: 1 }), `${origin}/loop`),
    /redirect limit/,
  );
});

test("fetch bounds bytes, preserves JSON, rejects binary and URL credentials", async (t) => {
  const origin = await server(t, (request, response) => {
    response.writeHead(200, {
      "content-type": request.url === "/binary" ? "application/octet-stream" : "application/json",
    });
    response.end('{"value":12345}');
  });
  const tool = createFetchTool({ allowedOrigins: [origin], maxBytes: 5 });
  assert.deepEqual(await execute(tool, origin), {
    url: `${origin}/`,
    contentType: "application/json",
    text: '{"val',
    truncated: true,
  });
  await assert.rejects(execute(tool, `${origin}/binary`), /unsupported content type/);
  await assert.rejects(execute(tool, origin.replace("http://", "http://user:password@")), /credentials/);
});

test("fetch aborts active requests and applies total timeout", async (t) => {
  let received;
  const started = new Promise((resolve) => {
    received = resolve;
  });
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("waiting");
    received();
  });
  const controller = new AbortController();
  const pending = execute(createFetchTool({ allowedOrigins: [origin] }), origin, controller.signal);
  const rejected = assert.rejects(pending, /abort/iu);
  await started;
  controller.abort();
  await rejected;
  await assert.rejects(execute(createFetchTool({ allowedOrigins: [origin], timeoutMs: 30 }), origin), /abort/iu);
});
