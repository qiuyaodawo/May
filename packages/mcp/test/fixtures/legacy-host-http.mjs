import { createServer } from "node:http";
import { once } from "node:events";
import { createLegacyHostPeer } from "./legacy-host-peer.mjs";

export async function startLegacyHostHttp(t) {
  const sessions = new Map();
  const requests = [];
  let seq = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    let id = request.headers["mcp-session-id"];
    if (message?.method === "initialize") {
      id = `session-${++seq}`;
      const session = { id, responses: new Map(), queued: [], stream: undefined, peer: undefined, closed: false };
      session.peer = createLegacyHostPeer((out) => {
        const target = session.responses.get(out.id);
        if (target) {
          session.responses.delete(out.id);
          target.writeHead(200, { "content-type": "application/json", "mcp-session-id": id }).end(JSON.stringify(out));
        } else if (session.stream) session.stream.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
        else if (!session.closed) session.queued.push(out);
      });
      sessions.set(id, session);
    }
    const session = sessions.get(id);
    requests.push({ id, method: request.method, message });
    if (!session) { response.writeHead(404).end(); return; }
    if (request.method === "GET") {
      session.stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
      for (const out of session.queued.splice(0)) response.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      response.on("close", () => { if (session.stream === response) session.stream = undefined; }); return;
    }
    if (request.method === "DELETE") {
      session.closed = true; session.peer.close(); session.stream?.end(); response.writeHead(204).end(); return;
    }
    if (message?.method && message.id !== undefined) session.responses.set(message.id, response);
    else response.writeHead(202).end();
    await session.peer.handle(message);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { for (const session of sessions.values()) { session.closed = true; session.peer.close(); session.stream?.end(); } server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, sessions, requests };
}
