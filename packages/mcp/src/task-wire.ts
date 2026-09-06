import { randomUUID } from "node:crypto";
import type { JSONRPCErrorResponse, JSONRPCResponse, JSONRPCNotification, RequestOptions, Transport, Tool } from "@modelcontextprotocol/client";
import { assertMcpContentSize } from "./content.js";
import { MCP_TASKS_EXTENSION, object, taskFailure } from "./tasks.js";

interface Pending {
  finish(value?: Record<string, unknown>, error?: Error): void;
  progress(params: Record<string, unknown>): void;
}

/**
 * Extension-owned string ids coexist with the SDK's numeric RPC and listen ids.
 * Uses documented transport sends and protected response dispatch, not private
 * SDK maps or a fabricated CallToolResult to bypass the core result decoder.
 */
export class McpTaskWire {
  private readonly prefix = `may-task:${randomUUID()}:`;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly serverId: () => string, private readonly transport: () => Transport | undefined, private readonly envelope: () => Readonly<Record<string, unknown>> | undefined) {}

  request(method: string, params: Record<string, unknown>, options: RequestOptions, definition?: Tool): Promise<Record<string, unknown>> {
    const transport = this.transport();
    const meta = this.envelope();
    if (transport === undefined || meta === undefined) return Promise.reject(taskFailure(this.serverId(), "Tasks require an open modern connection"));
    if (this.pending.size >= 64) return Promise.reject(taskFailure(this.serverId(), "too many task wire requests"));
    const id = this.prefix + ++this.sequence;
    const capabilities = object(meta["io.modelcontextprotocol/clientCapabilities"]) ? meta["io.modelcontextprotocol/clientCapabilities"] : {};
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    const timeout = Math.ceil(Math.min(options.timeout ?? 60_000, options.maxTotalTimeout ?? 60_000));
    const message = { jsonrpc: "2.0" as const, id, method, params: { ...params, _meta: { ...meta,
      "io.modelcontextprotocol/clientCapabilities": { ...capabilities, extensions: {
        ...(object(capabilities.extensions) ? capabilities.extensions : {}), [MCP_TASKS_EXTENSION]: {},
      } },
      ...(method === "tools/call" && options.onprogress ? { progressToken: id } : {}),
    } } };
    assertMcpContentSize(message);
    const headers = definition === undefined ? undefined : taskParamHeaders(definition.inputSchema, params.arguments);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => entry.finish(undefined, taskFailure(this.serverId(), "local task request cancelled; remote outcome may be unknown"));
      const reset = () => { clearTimeout(timer); timer = setTimeout(() => entry.finish(undefined, taskFailure(this.serverId(), "task request timeout; remote outcome may be unknown")), timeout); };
      const entry: Pending = {
        finish: (value, error) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort("Task wire leg settled");
          if (error !== undefined) reject(error); else resolve(value!);
        },
        progress: (params) => {
          if (method !== "tools/call" || typeof params.progress !== "number" || !Number.isFinite(params.progress)) return;
          if (options.resetTimeoutOnProgress) reset();
          try { options.onprogress?.(params as Parameters<NonNullable<RequestOptions["onprogress"]>>[0]); } catch { /* telemetry must not settle work */ }
        },
      };
      this.pending.set(id, entry); reset(); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void transport.send(message, { requestSignal: signal,
        onRequestStreamEnd: () => entry.finish(undefined, taskFailure(this.serverId(), "task response stream ended; operation is not replayed")),
        ...(headers === undefined ? {} : { headers }),
      }).catch(() => entry.finish(undefined, taskFailure(this.serverId(), "task transport failed; remote outcome may be unknown")));
    });
  }

  receive(response: JSONRPCResponse | JSONRPCErrorResponse): boolean {
    if (typeof response.id !== "string" || !response.id.startsWith(this.prefix)) return false;
    const entry = this.pending.get(response.id);
    if (entry === undefined) return true; // Deliberately discard a late extension response.
    if ("error" in response) entry.finish(undefined, taskFailure(this.serverId(), `task RPC failed (code ${response.error.code})`));
    else {
      try { assertMcpContentSize(response.result); if (!object(response.result)) throw new Error(); entry.finish(response.result); }
      catch { entry.finish(undefined, taskFailure(this.serverId(), "invalid task RPC response")); }
    }
    return true;
  }

  notification(message: JSONRPCNotification): boolean {
    const params = message.params;
    if (message.method !== "notifications/progress" || !object(params) || typeof params.progressToken !== "string" || !params.progressToken.startsWith(this.prefix)) return false;
    this.pending.get(params.progressToken)?.progress(params); return true;
  }
  close(): void { for (const entry of this.pending.values()) entry.finish(undefined, taskFailure(this.serverId(), "task connection closed; remote work is not cancelled")); }
}

/** SEP-2243 field encoding, including sentinel escaping; never URI encoding. */
export function taskHeaderValue(value: string): string {
  return value.length === 0 || value.trim() !== value || /[^\x09\x20-\x7e]/u.test(value) || value.startsWith("=?base64?") && value.endsWith("?=")
    ? `=?base64?${Buffer.from(value).toString("base64")}?=` : value;
}

function taskParamHeaders(schema: unknown, input: unknown): Readonly<Record<string, string>> | undefined {
  const headers: Record<string, string> = {};
  let valid = true;
  const walk = (node: unknown, value: unknown, reachable: boolean, depth: number) => {
    if (!object(node) || depth > 64) { if (depth > 64) valid = false; return; }
    const name = node["x-mcp-header"];
    if (name !== undefined) {
      if (!reachable || depth === 0 || typeof name !== "string" || !/^[!#$%&'*+.^_`|~\da-z-]+$/iu.test(name) || !["string", "integer", "boolean"].includes(node.type as string)) { valid = false; return; }
      const key = `Mcp-Param-${name}`.toLowerCase();
      if (Object.hasOwn(headers, key)) { valid = false; return; }
      // Reserve the name even when the optional value is absent, for collision checks.
      headers[key] = "";
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value)) headers[key] = taskHeaderValue(String(value));
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && object(child)) for (const [property, spec] of Object.entries(child)) walk(spec, object(value) ? value[property] : undefined, reachable, depth + 1);
      else if (["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "patternProperties", "dependentSchemas", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$defs", "definitions"].includes(key)) {
        const children = Array.isArray(child) ? child : object(child) && ["patternProperties", "dependentSchemas", "$defs", "definitions"].includes(key) ? Object.values(child) : [child];
        for (const entry of children) walk(entry, undefined, false, depth + 1);
      }
    }
  };
  walk(schema, input, true, 0);
  return valid ? Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== "")) : undefined;
}
