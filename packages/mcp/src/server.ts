import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Server, createMcpHandler, specTypeSchemas, type CallToolResult, type Resource, type Prompt, type ReadResourceResult, type GetPromptResult } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { Tool, ToolExecutor, ToolExecutionContext } from "@may/core";
import { assertMcpContentSize, mcpToolResultContent, mcpResourceToUserMessage, mcpPromptToUserMessage } from "./content.js";
import { freezeTree, object } from "./tasks.js";

export interface MayMcpPrincipal {
  readonly id: string;
  readonly workspaceId: string;
  /** Unix milliseconds. Expired principals cannot continue pending operations. */
  readonly expiresAt?: number;
}
export interface MayMcpExportContext {
  readonly principal: MayMcpPrincipal;
  readonly workspaceId: string;
  readonly signal: AbortSignal;
}
export interface MayMcpToolExport {
  readonly tool: Tool;
  /** Explicit public projection: raw tool output is NEVER exported by default. */
  readonly result: (output: unknown) => CallToolResult | Promise<CallToolResult>;
}
export interface MayMcpResourceExport {
  readonly definition: Resource;
  readonly read: (context: MayMcpExportContext) => Promise<ReadResourceResult>;
}
export interface MayMcpPromptExport {
  readonly definition: Prompt;
  readonly get: (args: Readonly<Record<string, string>>, context: MayMcpExportContext) => Promise<GetPromptResult>;
}
export interface MayMcpServerOptions {
  /** Exact externally addressed endpoint. HTTPS, or literal loopback HTTP for local use. */
  readonly endpoint: string;
  readonly workspaceId: string;
  /** Validate credentials, audience, expiry/revocation; never trust request body owner labels. */
  readonly authenticate: (request: Request, signal: AbortSignal) => Promise<MayMcpPrincipal | undefined>;
  /** Mandatory per-method/per-target policy, also used to filter discovery. */
  readonly authorize: (context: MayMcpExportContext & { readonly method: string; readonly target?: string }) => Promise<boolean>;
  readonly executor: ToolExecutor;
  readonly tools?: readonly MayMcpToolExport[];
  readonly resources?: readonly MayMcpResourceExport[];
  readonly prompts?: readonly MayMcpPromptExport[];
  /** Browser requests are denied unless their exact Origin is explicitly listed. No automatic CORS. */
  readonly allowedOrigins?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly legacy?: "reject" | "stateless";
}

/** Independent opt-in export surface. Does not listen, load workspace tools or inspect Sessions. */
export function createMayMcpServer(options: MayMcpServerOptions) {
  const endpoint = new URL(options.endpoint);
  if (endpoint.href !== options.endpoint || endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)) ||
      !label(options.workspaceId) || typeof options.authenticate !== "function" || typeof options.authorize !== "function" || typeof options.executor?.execute !== "function") throw new Error("Invalid May MCP server configuration");
  const timeout = options.requestTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000 || options.legacy !== undefined && !["reject", "stateless"].includes(options.legacy)) throw new Error("Invalid May MCP server limits");
  const origins = new Set(options.allowedOrigins ?? []);
  if (origins.size > 32 || [...origins].some((origin) => new URL(origin).origin !== origin || !/^https?:/u.test(origin))) throw new Error("Invalid allowed Origin");
  const validator = new AjvJsonSchemaValidator();
  const tools = (options.tools ?? []).map(({ tool, result }) => {
    if (typeof tool.execute !== "function" || typeof result !== "function" || tool.inputSchema.type !== "object") throw new Error("Exported tools require execution and public-result projection");
    const frozen = Object.freeze({ ...tool, execute: tool.execute.bind(tool), ...(tool.parse === undefined ? {} : { parse: tool.parse.bind(tool) }), inputSchema: freezeTree(structuredClone(tool.inputSchema)) });
    return { tool: frozen, result, validate: validator.getValidator(frozen.inputSchema) };
  });
  const resources = (options.resources ?? []).map((entry) => ({ ...entry, definition: freezeTree(structuredClone(entry.definition)) }));
  const prompts = (options.prompts ?? []).map((entry) => ({ ...entry, definition: freezeTree(structuredClone(entry.definition)) }));
  if (resources.some((entry) => typeof entry.read !== "function" || !label(entry.definition.name)) || prompts.some((entry) => typeof entry.get !== "function")) throw new Error("Invalid resource or prompt export");
  for (const keys of [tools.map(({ tool }) => tool.name), resources.map(({ definition }) => definition.uri), prompts.map(({ definition }) => definition.name)]) {
    if (keys.length > 256 || new Set(keys).size !== keys.length || keys.some((key) => !label(key))) throw new Error("Invalid or duplicate May MCP export");
  }
  assertMcpContentSize([tools.map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), resources.map((e) => e.definition), prompts.map((e) => e.definition)]);
  const lifetime = new AbortController();
  const http = new Set<ReturnType<typeof createMcpHandler>>();
  const stdio = new Set<StdioServerHandle>();
  let active = 0;
  const workspaceId = options.workspaceId;

  const valid = (principal: MayMcpPrincipal) => {
    if (!label(principal?.id) || principal.workspaceId !== workspaceId || principal.expiresAt !== undefined &&
        (!Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= Date.now())) throw denied();
  };
  const factory = (principal: MayMcpPrincipal, reauthenticate?: (signal: AbortSignal) => Promise<void>) => {
    valid(principal);
    const trusted = freezeTree(structuredClone(principal));
    const check = async (signal: AbortSignal, method: string, target?: string) => {
      signal.throwIfAborted(); valid(trusted);
      if (reauthenticate !== undefined) await bounded(signal, () => reauthenticate(signal));
      if (await bounded(signal, () => options.authorize({ principal: trusted, workspaceId, signal, method, ...(target === undefined ? {} : { target }) })) !== true) throw denied();
      signal.throwIfAborted(); valid(trusted);
    };
    const server = new GuardedServer(check, lifetime.signal, timeout);
    const permitted = async <T>(entries: readonly T[], key: (entry: T) => string, method: string, signal: AbortSignal) => {
      const result: T[] = [];
      for (const entry of entries) {
        try { await check(signal, method, key(entry)); result.push(entry); } catch { signal.throwIfAborted(); }
      }
      return result;
    };
    if (tools.length) {
      server.registerCapabilities({ tools: {} });
      server.setRequestHandler("tools/list", async (_request, ctx) => ({ tools: (await permitted(tools, (e) => e.tool.name, "tools/call", ctx.mcpReq.signal))
        .map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as { type: "object" } })) }));
      server.setRequestHandler("tools/call", async (request, ctx) => {
        const signal = ctx.mcpReq.signal;
        const entry = tools.find(({ tool }) => tool.name === request.params.name);
        if (entry === undefined) throw denied();
        await check(signal, "tools/call", entry.tool.name);
        const raw = structuredClone(request.params.arguments ?? {});
        if (!entry.validate(raw).valid) throw new Error("Invalid exported tool input");
        const input = entry.tool.parse?.(raw) ?? raw;
        const operationId = randomUUID();
        const context: ToolExecutionContext = { signal, scope: { workspaceId, principalId: trusted.id,
          sessionId: `mcp-export:${digest(JSON.stringify([workspaceId, trusted.id]))}` }, runId: operationId, toolCallId: operationId,
          idempotencyKey: operationId, step: 0, report() {} };
        // Recheck after permission waits, immediately before the actual side effect.
        const guardedTool: Tool = { ...entry.tool,
          permissionVersion: digest(JSON.stringify([entry.tool.permissionVersion, workspaceId, trusted, entry.tool.name, entry.tool.inputSchema])),
          execute: async (value, current) => { await check(signal, "tools/call", entry.tool.name); return entry.tool.execute(value, { ...current, ...context }); } };
        try {
          const output = await bounded(signal, () => options.executor.execute({ tool: guardedTool, input, context }));
          await check(signal, "tools/call", entry.tool.name);
          const result = await bounded(signal, () => Promise.resolve(entry.result(output)));
          mcpToolResultContent("may-export", entry.tool.name, result);
          const parsed = await specTypeSchemas.CallToolResult["~standard"].validate(result);
          if (parsed.issues !== undefined) throw denied();
          await check(signal, "tools/call", entry.tool.name); return parsed.value;
        } catch { signal.throwIfAborted(); return { isError: true, content: [{ type: "text", text: "Exported tool denied or failed; no automatic replay" }] }; }
      });
    }
    if (resources.length) {
      server.registerCapabilities({ resources: {} });
      server.setRequestHandler("resources/list", async (_request, ctx) => ({ resources: (await permitted(resources, (e) => e.definition.uri, "resources/read", ctx.mcpReq.signal)).map((e) => e.definition) }));
      server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
      server.setRequestHandler("resources/read", async (request, ctx) => {
        const entry = resources.find((e) => e.definition.uri === request.params.uri); if (entry === undefined) throw denied();
        await check(ctx.mcpReq.signal, "resources/read", entry.definition.uri);
        const result = await bounded(ctx.mcpReq.signal, () => entry.read({ principal: trusted, workspaceId, signal: ctx.mcpReq.signal }));
        mcpResourceToUserMessage({ serverId: "may-export", uri: entry.definition.uri, result, fromCache: false });
        const parsed = await specTypeSchemas.ReadResourceResult["~standard"].validate(result);
        if (parsed.issues !== undefined || result.contents.some((item) => item.uri !== entry.definition.uri) || result.contents.length > 128) throw denied();
        await check(ctx.mcpReq.signal, "resources/read", entry.definition.uri); return { ...parsed.value, ttlMs: 0, cacheScope: "private" as const };
      });
    }
    if (prompts.length) {
      server.registerCapabilities({ prompts: {} });
      server.setRequestHandler("prompts/list", async (_request, ctx) => ({ prompts: (await permitted(prompts, (e) => e.definition.name, "prompts/get", ctx.mcpReq.signal)).map((e) => e.definition) }));
      server.setRequestHandler("prompts/get", async (request, ctx) => {
        const entry = prompts.find((e) => e.definition.name === request.params.name); if (entry === undefined) throw denied();
        const args = request.params.arguments ?? {};
        if (Object.keys(args).some((key) => !entry.definition.arguments?.some((arg) => arg.name === key)) || entry.definition.arguments?.some((arg) => arg.required && args[arg.name] === undefined)) throw denied();
        await check(ctx.mcpReq.signal, "prompts/get", entry.definition.name);
        const result = await bounded(ctx.mcpReq.signal, () => entry.get(freezeTree(structuredClone(args)), { principal: trusted, workspaceId, signal: ctx.mcpReq.signal }));
        mcpPromptToUserMessage({ serverId: "may-export", name: entry.definition.name, arguments: args, result });
        const parsed = await specTypeSchemas.GetPromptResult["~standard"].validate(result);
        if (parsed.issues !== undefined || result.messages.length > 128) throw denied();
        await check(ctx.mcpReq.signal, "prompts/get", entry.definition.name); return parsed.value;
      });
    }
    return server;
  };

  return {
    async fetch(request: Request): Promise<Response> {
      if (lifetime.signal.aborted) return failure(503);
      if (request.url !== endpoint.href || request.headers.get("host") !== null && request.headers.get("host") !== endpoint.host ||
          request.headers.has("origin") && !origins.has(request.headers.get("origin")!)) return failure(403);
      if (request.method !== "POST") return failure(405);
      if (active >= 64) return failure(429);
      active++;
      const signal = AbortSignal.any([lifetime.signal, request.signal, AbortSignal.timeout(timeout)]);
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      try {
        const principal = await bounded(signal, () => options.authenticate(request, signal));
        if (principal === undefined) return failure(401);
        try { valid(principal); } catch { return failure(403); }
        const captured = freezeTree(structuredClone(principal));
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(415);
        const body = await readBody(request, signal);
        const reauthenticate = async (currentSignal: AbortSignal) => {
          const current = await options.authenticate(request, currentSignal);
          if (current === undefined || JSON.stringify(current) !== JSON.stringify(captured)) throw denied(); valid(current);
        };
        handler = createMcpHandler(() => factory(captured, reauthenticate), { legacy: options.legacy ?? "reject", onerror() {} });
        http.add(handler);
        const response = await bounded(signal, () => handler!.fetch(request, { parsedBody: body }));
        // Fully consume the bounded JSON response before releasing its per-request server.
        const text = await bounded(signal, () => response.text());
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) return failure(500);
        const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("x-content-type-options", "nosniff");
        return new Response(text || null, { status: response.status, headers });
      } catch { return failure(signal.aborted ? 408 : 400); }
      finally { active--; if (handler !== undefined) { http.delete(handler); await handler.close(); } }
    },
    /** Local launcher supplies the authenticated principal. No remote identity is accepted from stdin. */
    serveStdio(principal: MayMcpPrincipal, transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: 1024 * 1024 })) {
      lifetime.signal.throwIfAborted(); valid(principal);
      if (stdio.size >= 16) throw denied();
      const captured = freezeTree(structuredClone(principal));
      const handle = serveStdio(() => factory(captured), { transport, legacy: options.legacy === "stateless" ? "serve" : "reject", onerror() {} });
      const owned = { async close() { stdio.delete(owned); await handle.close(); } }; stdio.add(owned); return owned;
    },
    async close() { lifetime.abort("May MCP export server closed"); await Promise.allSettled([...http, ...stdio].map((handle) => handle.close())); },
  };
}

class GuardedServer extends Server {
  private active = 0;
  constructor(private readonly check: (signal: AbortSignal, method: string) => Promise<void>, private readonly lifetime: AbortSignal, private readonly timeout: number) {
    super({ name: "may-export", version: "0.1.0" });
  }
  protected override _wrapHandler(...args: Parameters<Server["_wrapHandler"]>): ReturnType<Server["_wrapHandler"]> {
    const wrapped = super._wrapHandler(...args);
    return async (request, context) => {
      if (this.active >= 64) throw denied();
      this.active++;
      const signal = AbortSignal.any([context.mcpReq.signal, this.lifetime, AbortSignal.timeout(this.timeout)]);
      try { await this.check(signal, args[0]); return await bounded(signal, () => wrapped(request, { ...context, mcpReq: { ...context.mcpReq, signal } })); }
      catch { throw denied(); } // Never publish callback/permission/provider exceptions.
      finally { this.active--; }
    };
  }
}

/** Simple provisioned-token authentication; not an OAuth authorization server. */
export function createMayMcpBearerAuthenticator(grants: readonly { readonly token: string; readonly principal: MayMcpPrincipal }[]) {
  if (grants.length === 0 || grants.length > 256 || grants.some((grant) => !/^[A-Za-z0-9._~+/-]{32,4096}=*$/u.test(grant.token))) throw new Error("Invalid provisioned MCP bearer grants");
  if (new Set(grants.map((grant) => grant.token)).size !== grants.length) throw new Error("Duplicate provisioned MCP bearer token");
  const entries = grants.map((grant) => ({ hash: createHash("sha256").update(grant.token).digest(), principal: freezeTree(structuredClone(grant.principal)) }));
  return {
    async authenticate(request: Request): Promise<MayMcpPrincipal | undefined> {
      const header = request.headers.get("authorization");
      if (header === null || !/^Bearer [^\s]{32,4096}$/iu.test(header)) return;
      const hash = createHash("sha256").update(header.slice(7)).digest();
      return entries.find((entry) => timingSafeEqual(hash, entry.hash) && (entry.principal.expiresAt === undefined || entry.principal.expiresAt > Date.now()))?.principal;
    },
    revoke(token: string) { const hash = createHash("sha256").update(token).digest(); for (let i = entries.length - 1; i >= 0; i--) if (timingSafeEqual(hash, entries[i]!.hash)) entries.splice(i, 1); },
  };
}
function label(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function denied(): Error { return new Error("MCP export not authorized, expired or failed"); }
function failure(status: number): Response { return new Response("MCP request rejected", { status, headers: { "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": 'Bearer realm="May MCP"' } : {}) } }); }
function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(denied()); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); return; }
    void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const reader = request.body?.getReader(); if (reader === undefined) throw denied();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await bounded(signal, () => reader.read()); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 1024 * 1024) throw denied(); chunks.push(next.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(body) || typeof body.method !== "string" || body.method === "subscriptions/listen") throw denied();
    return body;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
