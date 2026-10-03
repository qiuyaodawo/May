import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { definePlugin, defineService, type PluginDefinition, type ServiceToken } from "@may/plugin";

export interface WebApiRequestContext { readonly origin: string; readonly signal: AbortSignal }
export type WebApiHandler = (request: IncomingMessage, response: ServerResponse, context: WebApiRequestContext) => void | Promise<void>;
export interface WebApiService { readonly server: Server; readonly url: string; close(): Promise<void> }
export const webApiService = defineService<WebApiService>({ id: "may.web-api", version: "1.0.0", scope: "host" });
export function createWebApiPlugin(options: {
  readonly handler: ServiceToken<WebApiHandler>; readonly port?: number; readonly host?: string; readonly server?: Server; readonly id?: string;
}): PluginDefinition {
  const port = options.port ?? 3939;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid HTTP port");
  return definePlugin({
    id: options.id ?? "@may/plugin-web-api", version: "0.1.0", scope: "host", requires: [{ service: options.handler }], provides: [webApiService],
    async setup(context) {
      const server = options.server ?? createServer();
      const route = context.get(options.handler);
      const requests = new Set<Promise<void>>(), sockets = new Set<Socket>();
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let origin = "", closing: Promise<void> | undefined;
      const connection = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
      const handler = (request: IncomingMessage, response: ServerResponse) => {
        const work = Promise.resolve().then(() => route(request, response, { origin, signal })).catch(error => {
          if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
          else { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "HTTP request failed" })); }
        }).finally(() => requests.delete(work));
        requests.add(work);
      };
      const close = () => closing ??= (async () => {
        controller.abort(new Error("Web API plugin is closing"));
        server.removeListener("request", handler); server.removeListener("connection", connection);
        const stopped = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await Promise.allSettled(requests); await stopped;
      })();
      context.defer(close);
      server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 3000; server.maxConnections = 64;
      server.on("connection", connection);
      if (!server.listening) await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, options.host ?? "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Web API requires a TCP listener");
      const host = options.host ?? "127.0.0.1";
      origin = `http://${host.includes(":") ? `[${host}]` : host}:${(address as AddressInfo).port}`;
      if (options.server) server.removeAllListeners("request");
      server.on("request", handler);
      context.provide(webApiService, Object.freeze({ server, url: origin, close }));
    },
  });
}
