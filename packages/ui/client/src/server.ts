import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { UiError, type UiCommand, type UiHost, type UiReceipt } from "./protocol.js";

export type UiAssets = ReadonlyMap<string, { readonly type: string; readonly body: string }>;

/** Mount behind the host's authentication/origin checks. GET assets contain no secrets. */
export function createUiRouter(host: UiHost) {
  const receipts = new Map<string, { key: string; result: Promise<UiReceipt> }>();
  const streams = new Set<ServerResponse>();
  let closed = false;
  return {
    async route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/ui/")) return false;
      try {
        if (closed) throw new UiError(503, "宿主正在关闭。");
        if (req.method === "GET" && url.pathname === "/api/ui/snapshot") {
          const selected = url.searchParams.get("selected") ?? undefined;
          if (selected && selected.length > 256) throw new UiError(400, "无效的资源 ID。");
          sendJson(res, 200, await host.snapshot(selected));
        } else if (req.method === "GET" && url.pathname === "/api/ui/events") {
          if (streams.size >= 16) throw new UiError(429, "连接窗口过多。");
          streams.add(res);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
          res.write("event: invalidate\ndata: {}\n\n");
          let pending: ReturnType<typeof setTimeout> | undefined;
          const invalidate = () => {
            if (pending || res.destroyed) return;
            pending = setTimeout(() => {
              pending = undefined;
              if (!res.write("event: invalidate\ndata: {}\n\n")) res.destroy();
            }, 120);
          };
          const unsubscribe = host.subscribe(invalidate);
          // Repairs missed invalidations and observes changes from CLI/channel owners too.
          const heartbeat = setInterval(invalidate, 2000);
          res.once("close", () => { if (pending) clearTimeout(pending); clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
        } else if (req.method === "POST" && url.pathname === "/api/ui/commands") {
          const command = validateCommand(await readJson(req));
          if (command.hostId !== host.hostId) throw new UiError(409, "宿主已重启。请检查最新状态后重新操作。");
          const key = JSON.stringify({ ...command, args: Object.fromEntries(Object.entries(command.args).sort(([a], [b]) => a.localeCompare(b))) });
          let receipt = receipts.get(command.requestId);
          if (receipt && receipt.key !== key) throw new UiError(409, "请求 ID 已被其它命令使用。");
          if (!receipt) {
            // Do not silently evict a receipt and later repeat a side effect.
            if (receipts.size >= 4096) throw new UiError(429, "本次宿主的命令凭据已满，请在空闲时重启服务。");
            receipt = { key, result: Promise.resolve().then(() => host.execute(command)) };
            receipts.set(command.requestId, receipt);
          }
          sendJson(res, 200, await receipt.result);
        } else throw new UiError(404, "接口不存在。");
      } catch (error) {
        if (!res.headersSent) sendJson(res, error instanceof UiError ? error.status : 400, { error: error instanceof UiError ? error.message : "操作失败。请检查宿主日志、配置或当前状态。" });
        else res.destroy();
      }
      return true;
    },
    close() { closed = true; for (const stream of streams) stream.destroy(); streams.clear(); },
  };
}

export async function startUiServer(options: { host: UiHost; assets: UiAssets; token: string; port?: number; close?: () => Promise<void> }) {
  validateToken(options.token);
  const port = options.port ?? 3940;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const router = createUiRouter(options.host);
  let origin = "";
  const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = (async () => {
      secureHeaders(res);
      if (!trustedRequest(req, origin)) { sendJson(res, 403, { error: "Untrusted origin or host" }); return; }
      const asset = options.assets.get(req.url ?? "/");
      if (req.method === "GET" && asset) { res.writeHead(200, { "content-type": asset.type }); res.end(asset.body); return; }
      if (!authorized(req, options.token)) { sendJson(res, 401, { error: "请输入控制令牌。" }); return; }
      if (!await router.route(req, res)) sendJson(res, 404, { error: "Not found" });
    })().catch(() => { if (!res.headersSent) sendJson(res, 500, { error: "Host unavailable" }); else res.destroy(); }).finally(() => requests.delete(work));
    requests.add(work);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 3000; server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  return { url: origin, close: () => closing ??= (async () => {
    router.close();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await Promise.allSettled([...requests]); await options.close?.(); await stopped;
  })() };
}

export function secureHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
export function validateToken(token: string): void { if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("Control token must be 32..256 printable non-space ASCII characters"); }
export function trustedRequest(req: IncomingMessage, origin: string): boolean {
  return Boolean(origin) && req.headers.host === new URL(origin).host && (req.headers.origin === undefined || req.headers.origin === origin);
}
export function authorized(req: IncomingMessage, token: string): boolean {
  const supplied = req.headers.authorization ?? "", expected = `Bearer ${token}`;
  return Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
export function sendJson(res: ServerResponse, status: number, data: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new UiError(400, "需要 JSON。");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 96 * 1024) throw new UiError(413, "请求过大。"); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function validateCommand(value: unknown): UiCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiError(400, "无效的命令。");
  const c = value as UiCommand;
  if (Object.keys(c).some(key => !["version", "hostId", "requestId", "name", "targetId", "expectedActiveId", "args"].includes(key)) || c.version !== 1 || typeof c.hostId !== "string" || c.hostId.length > 128 || typeof c.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(c.requestId)
    || (c.expectedActiveId !== undefined && (typeof c.expectedActiveId !== "string" || !c.expectedActiveId || c.expectedActiveId.length > 256))
    || typeof c.name !== "string" || !/^[a-z][a-z0-9.-]{1,80}$/.test(c.name) || !(c.targetId === null || typeof c.targetId === "string" && c.targetId.length <= 256)
    || !c.args || typeof c.args !== "object" || Array.isArray(c.args) || Object.keys(c.args).length > 12 || Object.values(c.args).some(v => typeof v !== "string" || v.length > 20_000)) throw new UiError(400, "无效的命令。");
  return c;
}
