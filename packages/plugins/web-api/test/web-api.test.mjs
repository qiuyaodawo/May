import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { PluginHost, defineService } from "@may/plugin";
import { createWebApiPlugin, webApiService } from "../dist/index.js";

test("HTTP plugin serves actual files and releases streaming connections and its port", async t => {
  const handler = defineService({ id: "test.document-http-handler", version: "1.0.0", scope: "host" });
  const host = await PluginHost.create({ plugins: [createWebApiPlugin({ handler, port: 0 })], services: [{ service: handler, value: async (request, response, context) => {
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/plain" }); response.write("Document notifications\n");
      if (!context.signal.aborted) await once(context.signal, "abort");
      response.end(); return;
    }
    const content = await readFile(new URL("../package.json", import.meta.url), "utf8");
    response.writeHead(200, { "content-type": "application/json" }); response.end(content);
  } }] });
  t.after(() => host.close());
  const service = host.get(webApiService), port = service.server.address().port;
  assert.equal((await (await fetch(service.url)).json()).name, "@may/plugin-web-api");
  const stream = await fetch(service.url + "/stream");
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /Document notifications/);
  await Promise.all([host.close(), service.close(), service.close()]);
  assert.equal(service.server.listening, false);
  await reader.cancel().catch(error => { assert.ok(error instanceof TypeError); });
  const reopened = createServer();
  await new Promise((resolve, reject) => { reopened.once("error", reject); reopened.listen(port, "127.0.0.1", resolve); });
  await new Promise((resolve, reject) => reopened.close(error => error ? reject(error) : resolve()));
});

test("HTTP plugin startup failure leaves an existing occupied listener usable", async t => {
  const occupied = createServer((_, response) => { response.end("Occupied listener"); });
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  const port = occupied.address().port;
  const handler = defineService({ id: "test.listener-handler", version: "1.0.0", scope: "host" });
  await assert.rejects(PluginHost.create({ plugins: [createWebApiPlugin({ handler, port })], services: [{ service: handler, value: async (_, response) => { response.end(await readFile(new URL("../package.json", import.meta.url))); } }] }), error => {
    assert.equal(error.cause.code, "EADDRINUSE"); return true;
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "Occupied listener");
});
