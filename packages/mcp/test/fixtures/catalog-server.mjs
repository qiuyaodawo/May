import { createServer } from "node:http";
import { once } from "node:events";

export async function startCatalogFixture(t) {
  const requests = [];
  const listeners = new Set();
  const state = { version: 1, available: true, repeatCursor: false, holdList: false };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: request.method, path: request.url, message });
    if (!state.available) { response.writeHead(503).end(); return; }
    const modern = request.url !== "/legacy";
    const resourcesOnly = request.url === "/resources";
    const capabilities = { resources: { listChanged: true }, prompts: { listChanged: true },
      ...(!resourcesOnly ? { tools: { listChanged: true } } : {}) };
    const reply = (result) => response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result } : result }));
    const listen = (id) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      const emit = (method, params = {}) => response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method,
        params: { ...params, ...(id === undefined ? {} : { _meta: { "io.modelcontextprotocol/subscriptionId": id } }) } })}\n\n`);
      listeners.add(emit);
      response.on("close", () => listeners.delete(emit));
      return emit;
    };
    if (request.method === "GET") {
      if (!modern) listen(); else response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    if (message.method === "server/discover") {
      if (modern) reply({ supportedVersions: ["2026-07-28"], capabilities,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "catalog-fixture", version: "1" } } });
      else response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Method not found" } }));
      return;
    }
    if (message.method === "initialize") {
      response.setHeader("mcp-session-id", "catalog-fixture");
      reply({ protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "catalog-fixture", version: "1" } }); return;
    }
    if (message.method === "subscriptions/listen") {
      listen(message.id)("notifications/subscriptions/acknowledged", { notifications: message.params.notifications }); return;
    }
    if (message.method === "tools/list") {
      if (state.holdList) return;
      reply({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" },
        annotations: { readOnlyHint: state.version === 1 } }], ttlMs: 600_000, cacheScope: "public" }); return;
    }
    if (message.method === "resources/list") {
      const second = message.params?.cursor !== undefined;
      reply({ resources: [{ name: second ? "second" : "first", uri: `test:///${second ? "second" : "first"}` }],
        ...(!second || state.repeatCursor ? { nextCursor: "next" } : {}) }); return;
    }
    if (message.method === "resources/templates/list") {
      reply({ resourceTemplates: [{ name: "file", uriTemplate: "test:///{name}" }] }); return;
    }
    if (message.method === "prompts/list") {
      reply({ prompts: [{ name: "review", arguments: [{ name: "file", required: true }] }] }); return;
    }
    if (message.method === "tools/call") {
      if (message.params.arguments?.hold) return;
      reply({ content: [{ type: "text", text: `version:${state.version}` }] }); return;
    }
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, state, requests,
    notify() { for (const emit of listeners) emit("notifications/tools/list_changed"); },
  };
}
