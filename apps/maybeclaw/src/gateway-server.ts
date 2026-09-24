import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { webUiAssets } from "@may/web-ui/assets";
import { createUiRouter, secureHeaders, sendJson, trustedRequest } from "@may/ui-client/server";
import { GatewayAuth } from "./gateway-auth.js";
import { UiError, type UiCommand } from "@may/ui-client";
import { GatewayUiHost, controlActor } from "./gateway-ui.js";
import type { AgentGateway } from "./gateway.js";
import type { GatewayApproval, GatewayTask } from "./gateway-types.js";
import type { LegacyTaskRecord } from "./gateway-migration.js";

export async function startGatewayServer(options: { gateway: AgentGateway; port?: number; server?: Server; status?: () => unknown; close?: () => Promise<void>; retryLegacyDelivery?: (id: string, confirmUnknown: boolean) => unknown }) {
  const publicOrigin = options.gateway.options.settings.publicOrigin;
  const port = options.port ?? 3939;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const assets = new Map(await webUiAssets("MaybeClaw", "session"));
  assets.set("/gateway-browser.js", { type: "text/javascript; charset=utf-8", body: await readFile(new URL("./gateway-browser.js", import.meta.url), "utf8") });
  assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: 'import { UiClient } from "/ui/client.js"; import { mountWebUI } from "/webui/index.js"; import { createGatewayManager, gatewayAuthentication } from "/gateway-browser.js"; const client = new UiClient(); const root = document.getElementById("app"); const manager = createGatewayManager(client); const unmount = mountWebUI(root, client, { title: "MaybeClaw", kind: "session", authentication: gatewayAuthentication(), connectionHint: "输入配置的管理员密码。刷新页面后需要重新登录。", onNew: manager.onNew, navigation: manager.navigation }); window.addEventListener("beforeunload", () => { unmount(); manager.dispose(); });' });
  const auth = await GatewayAuth.open(options.gateway.options.configPath);
  const uiHost = new GatewayUiHost(options.gateway, options.status, options.retryLegacyDelivery);
  const ui = createUiRouter(uiHost);
  const requests = new Set<Promise<void>>();
  let origin = "";
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const work = route(req, res).catch((error: unknown) => {
      if (res.headersSent) res.destroy();
      else sendJson(res, error instanceof UiError ? error.status : 400, { error: error instanceof Error ? error.message : "Gateway operation failed" });
    }).finally(() => requests.delete(work));
    requests.add(work);
  };
  const server = options.server ?? createServer();
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 3000; server.maxConnections = 64;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    secureHeaders(res);
    if (!trustedRequest(req, origin) && !(publicOrigin && trustedRequest(req, publicOrigin))) { sendJson(res, 403, { error: "Untrusted origin or host" }); return; }
    const url = new URL(req.url ?? "/", origin);
    const asset = assets.get(url.pathname);
    if (req.method === "GET" && asset) { res.writeHead(200, { "content-type": asset.type }); res.end(asset.body); return; }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const data = await body(req, 8192); if (Object.keys(data).length !== 1) throw new UiError(400, "需要管理员密码。");
      sendJson(res, 200, await auth.login(data.password)); return;
    }
    await auth.refresh();
    const login = auth.authorize(req);
    if (!login) { sendJson(res, 401, { error: "请使用管理员密码登录。" }); return; }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") { auth.revoke(login); sendJson(res, 200, { loggedOut: true }); return; }
    if (url.pathname === "/api/ui/events") auth.track(login, res);
    if (await ui.route(req, res)) return;
    const path = url.pathname.replace(/^\/api\/v2(?=\/)/u, "/api");
    if (req.method === "GET") {
      if (path === "/api/health") { sendJson(res, 200, options.status?.() ?? options.gateway.status()); return; }
      if (path === "/api/sessions") { sendJson(res, 200, options.gateway.sessions(controlActor)); return; }
      if (path === "/api/agents") { sendJson(res, 200, options.gateway.options.settings.agents); return; }
      if (path === "/api/approvals") { sendJson(res, 200, options.gateway.store.list<GatewayApproval>("approvals")); return; }
      if (path === "/api/tasks") { sendJson(res, 200, { tasks: options.gateway.store.list<GatewayTask>("tasks"), legacy: options.gateway.store.list<LegacyTaskRecord>("legacy-tasks") }); return; }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages))?$/u.exec(path);
      if (sessionMatch) {
        const session = options.gateway.session(decodeURIComponent(sessionMatch[1]!), controlActor);
        sendJson(res, 200, sessionMatch[2] ? options.gateway.messages(session.id, controlActor) : session); return;
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/u.exec(path);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]!);
        const task = options.gateway.store.get<GatewayTask>("tasks", id), legacy = options.gateway.store.get<LegacyTaskRecord>("legacy-tasks", id);
        if (!task && !legacy) throw new UiError(404, "Task not found");
        sendJson(res, 200, task ? { task } : { legacy }); return;
      }
    }
    if (req.method === "POST") {
      const data = await body(req);
      const requestId = typeof data.requestId === "string" ? data.requestId : randomUUID();
      if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(requestId)) throw new UiError(400, "Invalid requestId");
      if (path === "/api/commands") {
        if (typeof data.text !== "string") throw new UiError(400, "需要命令正文。");
        const result = await execute("gateway.command", data, { text: data.text, ...(data.entry ? { entry: JSON.stringify(data.entry) } : {}) }, requestId);
        sendJson(res, 200, result); return;
      }
      if (path === "/api/sessions") {
        if (typeof data.name !== "string" || !Array.isArray(data.agents)) throw new UiError(400, "name and agents are required");
        const result = await execute("session.create", data, { name: data.name, agents: JSON.stringify(data.agents), allowed: JSON.stringify(data.allowedAgents ?? []), ...(data.entry ? { entry: JSON.stringify(data.entry) } : {}) }, requestId);
        sendJson(res, 201, { ...result, session: options.gateway.session(result.selectedId!, controlActor) }); return;
      }
      if (path === "/api/tasks") {
        if (typeof data.sessionId !== "string" || !data.sessionId || typeof data.prompt !== "string" || !data.prompt.trim() || typeof data.requestId !== "string") throw new UiError(400, "sessionId, prompt and requestId are required; use task submit <prompt> --session <id>");
        const text = typeof data.agent === "string" ? `@${data.agent} -- ${data.prompt}` : data.prompt;
        const result = await options.gateway.handle(text, controlActor, { requestId: `api:${requestId}`, sessionId: data.sessionId });
        sendJson(res, 202, result); return;
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)\/(cancel|recover|dispatch)$/u.exec(path);
      if (taskMatch) {
        const task = options.gateway.store.get<GatewayTask>("tasks", decodeURIComponent(taskMatch[1]!));
        if (!task) throw new UiError(404, "Gateway task not found; legacy work requires explicit assignment to a session");
        if (taskMatch[2] === "cancel") await options.gateway.stop(options.gateway.session(task.sessionId, controlActor), controlActor, undefined, task.id);
        else if (taskMatch[2] === "recover") await options.gateway.recoverTask(task.id, controlActor);
        else await options.gateway.dispatchTask(task.id, controlActor);
        sendJson(res, 200, { task: options.gateway.store.get("tasks", task.id) }); return;
      }
      const legacyDelivery = /^\/api\/legacy-deliveries\/([^/]+)\/retry$/u.exec(path);
      if (legacyDelivery) {
        if (!options.retryLegacyDelivery) throw new UiError(409, "重新发送需要正在运行的 GatewayHost。");
        if (data.confirmUnknown !== undefined && typeof data.confirmUnknown !== "boolean") throw new UiError(400, "confirmUnknown must be a boolean");
        sendJson(res, 200, { delivery: options.retryLegacyDelivery(decodeURIComponent(legacyDelivery[1]!), data.confirmUnknown === true) }); return;
      }
      const delivery = /^\/api\/deliveries\/([^/]+)\/retry$/u.exec(path);
      if (delivery) {
        if (data.confirmUnknown !== undefined && typeof data.confirmUnknown !== "boolean") throw new UiError(400, "confirmUnknown must be a boolean");
        const id = decodeURIComponent(delivery[1]!);
        options.gateway.retryDelivery(id, controlActor, data.confirmUnknown === true);
        sendJson(res, 200, { delivery: options.gateway.store.get("deliveries", id) ?? options.gateway.store.get("channel-replies", id) }); return;
      }
      if (path === "/api/agents") {
        if (typeof data.id !== "string") throw new UiError(400, "Agent id is required");
        await execute("agent.save", data, { id: data.id, config: JSON.stringify(data.config) }, requestId); sendJson(res, 200, { updated: data.id }); return;
      }
      if (path === "/api/approvals") {
        if (typeof data.id !== "string" || typeof data.decision !== "string") throw new UiError(400, "Approval id and decision are required");
        await execute("approval.resolve", data, { id: data.id, decision: data.decision }, requestId); sendJson(res, 200, { resolved: data.id }); return;
      }
    }
    sendJson(res, 404, { error: "Not found" });
  }
  function execute(name: string, data: Record<string, unknown>, args: Record<string, string>, requestId: string) {
    const command: UiCommand = { version: 1, hostId: uiHost.hostId, requestId, name, targetId: typeof data.sessionId === "string" ? data.sessionId : null, args };
    return uiHost.execute(command);
  }
  if (!options.server) await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  }).catch(async error => { await auth.close(); ui.close(); uiHost.close(); throw error; });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.removeAllListeners("request");
  server.on("request", handler);
  let closing: Promise<void> | undefined;
  return { url: origin, ...(publicOrigin ? { publicUrl: publicOrigin } : {}), close: () => closing ??= (async () => {
    await auth.close(); ui.close(); uiHost.close();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await Promise.allSettled([...requests]);
    await (options.close?.() ?? options.gateway.close()); await stopped;
  })() };
}

async function body(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new UiError(400, "JSON required");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > limit) throw new UiError(413, "Request too large"); chunks.push(bytes); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new UiError(400, "Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiError(400, "JSON object required");
  return value as Record<string, unknown>;
}
