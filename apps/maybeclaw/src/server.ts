import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MaybeClawHost } from "./host.js";
import { validateId } from "./types.js";
import { WEB_HTML, WEB_CSS, WEB_JS } from "./web.js";

export interface ServerOptions { host: MaybeClawHost; token: string; port?: number }

/** Loopback-only operator API. The token is intentionally not accepted in URLs/cookies. */
export async function startControlServer(options: ServerOptions) {
  if (!/^[\x21-\x7e]{32,256}$/.test(options.token)) throw new Error("Control token must be 32..256 printable non-space ASCII characters");
  const port = options.port ?? 3939;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  let origin = "";
  const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = route(req, res).catch(() => {
      if (!res.headersSent) json(res, 400, { error: "Request failed. Check the task ID, input, host configuration or local journal." });
      else res.destroy();
    }).finally(() => requests.delete(work));
    requests.add(work);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 3000;
  server.maxConnections = 64;
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) { json(res, 403, { error: "Untrusted origin or host" }); return; }
    const path = req.url ?? "/";
    if (req.method === "GET" && ["/", "/app.css", "/app.js"].includes(path)) {
      const [type, body] = path === "/" ? ["text/html", WEB_HTML] : path === "/app.css" ? ["text/css", WEB_CSS] : ["text/javascript", WEB_JS];
      res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(body); return;
    }
    const supplied = req.headers.authorization ?? "";
    const expected = `Bearer ${options.token}`;
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { json(res, 401, { error: "Operator token required" }); return; }
    if (req.method === "GET" && path === "/api/health") { json(res, 200, options.host.status()); return; }
    if (req.method === "GET" && path === "/api/tasks") { json(res, 200, await options.host.claw.store.list()); return; }
    if (req.method === "POST" && path === "/api/tasks") {
      const body = await readBody(req);
      if (Object.keys(body).some((v) => !["prompt", "requestId"].includes(v)) || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 16_384 || typeof body.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(body.requestId)) throw new Error("Invalid submission");
      const result = await options.host.submit(body.prompt, `api:${body.requestId}`);
      json(res, result.created ? 202 : 200, result); return;
    }
    const match = /^\/api\/tasks\/([a-f0-9]{64})(?:\/(cancel|recover|dispatch))?$/.exec(path);
    if (match) {
      const id = match[1]!; validateId(id);
      if (req.method === "GET" && !match[2]) { json(res, 200, await options.host.claw.status(id)); return; }
      if (req.method === "POST" && match[2]) {
        const body = await readBody(req);
        if (Object.keys(body).length) throw new Error("Expected an empty body");
        if (match[2] === "cancel") json(res, 202, await options.host.claw.cancel(id));
        else if (match[2] === "recover") json(res, 200, { task: await options.host.claw.recover(id) });
        else { const snapshot = await options.host.claw.status(id); options.host.retryDispatch(id); json(res, 202, snapshot); }
        return;
      }
    }
    json(res, 404, { error: "Not found" });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.host.startLoops();
  let closing: Promise<void> | undefined;
  return { url: origin, close: () => closing ??= (async () => {
    const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await Promise.allSettled([...requests]);
    await options.host.close();
    await stopped;
  })() };
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new Error("JSON required");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 96 * 1024) throw new Error("Body too large");
    chunks.push(bytes);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Object required");
  return data as Record<string, unknown>;
}
