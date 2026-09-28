import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { UiError, type UiHost } from "@may/ui-client";
import {
  BrowserLogin,
  createUiRouter,
  secureHeaders,
  sendJson,
  trustedRequest,
  validateToken,
  authorized,
  type UiAssets,
} from "@may/ui-client/server";
import { randomBytes } from "node:crypto";

export interface AssistantServerOptions {
  readonly host: UiHost;
  readonly assets: UiAssets;
  readonly token: string;
  readonly bind: string;
  readonly port: number;
  /** 允许手机通过一次性票据直接连接，不需要手动输入令牌。 */
  readonly browserLogin: boolean;
  readonly close?: () => Promise<void>;
}

export interface AssistantServer {
  readonly url: string;
  readonly loginUrl: string | undefined;
  close(): Promise<void>;
}

/**
 * 工作台 HTTP 服务。认证、来源校验、票据与路由全部复用 @may/ui-client/server，
 * 这里只把监听地址做成可配置，便于手机通过局域网访问。
 */
export async function startAssistantServer(options: AssistantServerOptions): Promise<AssistantServer> {
  validateToken(options.token);
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("端口必须是 0 到 65535 之间的整数");
  }
  const router = createUiRouter(options.host);
  const login = options.browserLogin ? new BrowserLogin(options.token) : undefined;
  let origin = "";
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      secureHeaders(response);
      if (!trustedRequest(request, origin)) {
        sendJson(response, 403, { error: "不受信任的来源或主机" });
        return;
      }
      if (login !== undefined && request.method === "POST" && request.url === "/api/ui/connect") {
        await redeemTicket(request, response, login);
        return;
      }
      const asset = options.assets.get(request.url ?? "/");
      if (request.method === "GET" && asset !== undefined) {
        response.writeHead(200, { "content-type": asset.type });
        response.end(asset.body);
        return;
      }
      if (!authorized(request, options.token)) {
        sendJson(response, 401, { error: "请输入控制令牌" });
        return;
      }
      if (!await router.route(request, response)) {
        sendJson(response, 404, { error: "接口不存在" });
      }
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "宿主不可用" });
      else response.destroy();
    }).finally(() => pending.delete(work));
    pending.add(work);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 3_000;
  server.maxConnections = 64;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  let closing: Promise<void> | undefined;
  return {
    url: origin,
    get loginUrl() {
      return login === undefined ? undefined : `${origin}/#may-connect=${login.issue()}`;
    },
    close() {
      closing ??= (async () => {
        login?.clear();
        router.close();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())));
        server.closeAllConnections();
        await options.close?.();
        await Promise.allSettled([...pending]);
        await stopped;
      })();
      return closing;
    },
  };
}

async function redeemTicket(
  request: IncomingMessage,
  response: ServerResponse,
  login: BrowserLogin,
): Promise<void> {
  try {
    const body: unknown = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("ticket" in body) || typeof body.ticket !== "string") {
      throw new UiError(400, "连接请求无效");
    }
    sendJson(response, 200, { token: login.redeem(body.ticket) });
  } catch (error) {
    if (!(error instanceof UiError)) throw error;
    sendJson(response, error.status, { error: error.message });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new UiError(400, "需要 JSON");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new UiError(413, "请求过大");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createControlToken(): string {
  return randomBytes(32).toString("base64url");
}
