import { createServer } from "node:http";
import { once } from "node:events";

export async function startHttpFixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const message = body ? JSON.parse(body) : undefined;
    requests.push({ method: request.method, path: request.url, headers: request.headers, message });
    if (request.url === "/silent") return;
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/leaked" }).end();
      return;
    }
    if (request.url === "/unavailable" || request.url === "/unauthorized") {
      response.writeHead(request.url === "/unauthorized" ? 401 : 503)
        .end("sensitive-response-body Bearer test-secret");
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const modern = request.url === "/modern";
    const reply = (result) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: modern ? { resultType: "complete", ...result } : result,
      }));
    };
    if (message.method === "server/discover") {
      if (modern) {
        reply({
          supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "http-fixture", version: "1" } },
        });
      } else {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" },
        }));
      }
      return;
    }
    if (message.method === "initialize") {
      response.setHeader("mcp-session-id", "fixture-session");
      reply({
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "http-fixture", version: "1" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        ttlMs: 0, cacheScope: "private",
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      });
      return;
    }
    if (message.method === "tools/call") {
      const value = message.params.arguments?.value;
      if (value === "never") return;
      if (value === "http-error") {
        response.writeHead(503).end("sensitive-response-body Bearer test-secret");
        return;
      }
      if (value === "tool-error") {
        reply({ isError: true, content: [{ type: "text", text: "remote tool failed" }] });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (entry) => response.write(`event: message\ndata: ${JSON.stringify(entry)}\n\n`);
      emit({
        jsonrpc: "2.0", method: "notifications/progress",
        params: { progressToken: message.params._meta.progressToken, progress: 1, message: "http progress" },
      });
      emit({
        jsonrpc: "2.0", id: message.id,
        result: {
          ...(modern ? { resultType: "complete" } : {}),
          content: [{ type: "text", text: value }], structuredContent: { echoed: value },
        },
      });
      response.end();
      return;
    }
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
