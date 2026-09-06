import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import { McpConfigurationError, McpContentError } from "./errors.js";
import { assertMcpServerId } from "./names.js";
import type { McpServerOptions } from "./types.js";
import { McpAuthenticationError, validateMcpOAuthOptions, type McpOAuthManager } from "./oauth.js";
import { McpCredentialStoreError } from "./credentials.js";

export function createMcpTransport(options: McpServerOptions, oauth?: McpOAuthManager) {
  if (options.transport === "streamable-http") {
    if (options.auth !== undefined && oauth === undefined) {
      throw new McpConfigurationError(`MCP server "${options.id}" requires an OAuth credential manager`);
    }
    return new StreamableHTTPClientTransport(new URL(options.url), {
      ...(options.auth === undefined ? {} : { authProvider: oauth!.binding(options) }),
      onInsufficientScope: "throw",
      requestInit: {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        redirect: "error",
      },
      // Do not resume streams or replay an operation with an uncertain outcome.
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
      },
      fetch: async (input, init) => {
        // Also bound legacy session DELETE cleanup, which has no RPC timeout.
        const signal = init?.method === "DELETE"
          ? AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(Math.ceil(Math.min(options.requestTimeoutMs ?? 5_000, 5_000))),
            ])
          : init?.signal;
        const response = await fetch(input, {
          ...init,
          ...(signal === undefined ? {} : { signal }),
          redirect: "error",
        });
        if (response.status === 403 && options.auth !== undefined) {
          try { await oauth!.requireConsent(options, response); }
          catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        }
        return boundMcpResponse(response);
      },
    });
  }
  return orderedStdio(new StdioClientTransport({
    command: options.command,
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined
      ? {}
      : { env: { ...getDefaultEnvironment(), ...options.env } }),
    ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
    stderr: "pipe",
  }));
}

/** Validate before starting any endpoint, including optional endpoints. */
export function validateMcpServerOptions(options: McpServerOptions): void {
  assertMcpServerId(options.id);
  if (options.required !== undefined && typeof options.required !== "boolean") {
    invalid(options, "required must be a boolean");
  }
  if (options.protocolMode !== undefined &&
      options.protocolMode !== "legacy" && options.protocolMode !== "auto") {
    invalid(options, 'protocolMode must be "legacy" or "auto"');
  }
  positiveNumber(options.requestTimeoutMs, options, "requestTimeoutMs");
  positiveNumber(options.maxTotalTimeoutMs, options, "maxTotalTimeoutMs");
  if (options.host !== undefined) {
    if (options.host === null || typeof options.host !== "object" || Array.isArray(options.host) ||
        Object.keys(options.host).some((key) => !["roots", "sampling", "legacyRequests"].includes(key))) invalid(options, "host contains invalid compatibility options");
    if (options.host.roots !== undefined && typeof options.host.roots !== "boolean" ||
        options.host.sampling !== undefined && typeof options.host.sampling !== "boolean" ||
        options.host.legacyRequests !== undefined && options.host.legacyRequests !== "isolated") invalid(options, "host requires boolean roots/sampling and optional legacyRequests=isolated");
  }
  if (options.transport === "streamable-http") {
    rejectFields(options, ["command", "args", "cwd", "env", "maxBufferSize", "stderrMaxBytes"]);
    let url: URL;
    try {
      if (typeof options.url !== "string" || options.url.trim() === "") throw new Error();
      url = new URL(options.url);
    } catch {
      return invalid(options, "url must be an absolute HTTPS URL (HTTP is loopback-only)");
    }
    if (url.username || url.password || url.hash) {
      invalid(options, "url must not contain credentials or a fragment; use headers for authentication");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      invalid(options, "url must use HTTPS (HTTP is loopback-only)");
    }
    validateStringMap(options.headers, options, "headers");
    if (options.auth !== undefined) {
      try { validateMcpOAuthOptions(options.auth); }
      catch { invalid(options, "auth contains invalid OAuth options (clientId requires expectedIssuer)"); }
      if (Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "authorization")) {
        invalid(options, "OAuth and a static Authorization header cannot be combined");
      }
    }
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const key = name.toLowerCase();
      if (seen.has(key)) invalid(options, "headers must not contain duplicate names");
      seen.add(key);
      if (key.startsWith("mcp-") || [
        "host", "connection", "content-length", "transfer-encoding", "upgrade",
        "accept", "content-type", "origin", "cookie", "proxy-authorization",
      ].includes(key)) invalid(options, "headers must not override protocol or transport headers");
      try {
        new Headers({ [name]: value });
      } catch {
        invalid(options, "headers contain an invalid name or value");
      }
    }
    return;
  }
  if (options.transport !== undefined && options.transport !== "stdio") {
    invalid(options, 'transport must be "stdio" or "streamable-http"');
  }
  rejectFields(options, ["url", "headers", "auth"]);
  if (typeof options.command !== "string" || options.command.trim() === "") {
    invalid(options, "command must be a non-empty string");
  }
  if (options.args !== undefined && (!Array.isArray(options.args) ||
      options.args.some((argument) => typeof argument !== "string"))) {
    invalid(options, "arguments must be strings");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.trim() === "")) {
    invalid(options, "cwd must be a non-empty string");
  }
  validateStringMap(options.env, options, "environment");
  positiveNumber(options.maxBufferSize, options, "maxBufferSize");
  positiveNumber(options.stderrMaxBytes, options, "stderrMaxBytes");
}

/** HTTP SDK errors can include URLs, response bodies and credentials. */
export function safeMcpTransportError(error: unknown, options: McpServerOptions): unknown {
  if (options.transport !== "streamable-http") return error;
  if (error instanceof McpAuthenticationError || error instanceof McpCredentialStoreError) return error;
  const data = error instanceof Error && "data" in error ? error.data : undefined;
  const status = typeof data === "object" && data !== null && "status" in data
    && typeof data.status === "number" && Number.isInteger(data.status)
    && data.status >= 100 && data.status <= 599 ? data.status : undefined;
  return new Error(status === undefined
    ? "HTTP MCP operation failed (endpoint and response details withheld)"
    : `HTTP MCP operation failed with status ${status}`);
}

function invalid(options: McpServerOptions, detail: string): never {
  throw new McpConfigurationError(`MCP server "${options.id}": ${detail}`);
}

function rejectFields(options: McpServerOptions, fields: readonly string[]): void {
  for (const field of fields) {
    if (field in options) invalid(options, `${field} is not supported for this transport`);
  }
}

function positiveNumber(value: number | undefined, options: McpServerOptions, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    invalid(options, `${field} must be a positive number`);
  }
}

function validateStringMap(value: unknown, options: McpServerOptions, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.entries(value).some(([name, item]) => name === "" || typeof item !== "string")) {
    invalid(options, `${field} entries must be string pairs`);
  }
}

/** Bound a JSON response or each SSE frame before the SDK buffers/parses it. */
function boundMcpResponse(response: Response): Response {
  if (response.body === null) return response;
  const sse = response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "text/event-stream";
  const maximum = 10 * 1024 * 1024;
  let bytes = 0;
  let lineBytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sse) bytes += chunk.byteLength;
      else for (const byte of chunk) {
        bytes++;
        if (bytes > maximum) throw new McpContentError("MCP protocol frame exceeds 10 MiB");
        if (byte === 10) {
          if (lineBytes === 0) bytes = 0;
          lineBytes = 0;
        } else if (byte !== 13) lineBytes++;
      }
      if (bytes > maximum) throw new McpContentError("MCP protocol frame exceeds 10 MiB");
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Let SDK notification microtasks settle before a later frame clears request handlers. */
function orderedStdio(transport: StdioClientTransport): StdioClientTransport {
  let receiver: StdioClientTransport["onmessage"];
  let delivery = Promise.resolve();
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => receiver,
    set: (handler: StdioClientTransport["onmessage"]) => {
      receiver = handler === undefined ? undefined : (...args) => {
        delivery = delivery.then(() => { handler(...args); })
          .catch((error: unknown) => transport.onerror?.(error instanceof Error ? error : new Error("MCP message delivery failed")));
      };
    },
  });
  return transport;
}
