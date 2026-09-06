import type {
  Tool,
  TraceAttributes,
  Tracer,
} from "@may/core";
import type { McpOAuthManager, McpOAuthOptions } from "./oauth.js";

export type McpTransport = "stdio" | "streamable-http";

export interface McpServerBaseOptions {
  /** Stable configuration id used to namespace every remote tool. */
  readonly id: string;
  /** Whether failure to start this server aborts the whole pool. Defaults to true. */
  readonly required?: boolean;
  /** Per-request inactivity timeout. The SDK default is 60 seconds. */
  readonly requestTimeoutMs?: number;
  /** Absolute upper bound for a request, including progress notifications. */
  readonly maxTotalTimeoutMs?: number;
  /** SDK negotiation mode. Defaults to legacy for stdio, auto for HTTP. */
  readonly protocolMode?: "legacy" | "auto";
}

export interface McpStdioServerOptions extends McpServerBaseOptions {
  /** Omission preserves the original stdio API. */
  readonly transport?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Explicit child-process environment additions. Values are never traced. */
  readonly env?: Readonly<Record<string, string>>;
  /** Maximum size of one protocol message. The SDK default is 10 MiB. */
  readonly maxBufferSize?: number;
  /** Retained tail of stderr used for diagnostics. Defaults to 16 KiB. */
  readonly stderrMaxBytes?: number;
}

export interface McpHttpServerOptions extends McpServerBaseOptions {
  readonly transport: "streamable-http";
  /** HTTPS endpoint; plaintext HTTP is allowed only for literal loopback hosts. */
  readonly url: string;
  /** Static headers, including optional authorization. Never included in diagnostics. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: McpOAuthOptions;
}

export type McpServerOptions = McpStdioServerOptions | McpHttpServerOptions;

export interface OpenMcpClientPoolOptions {
  readonly servers: readonly McpServerOptions[];
  readonly tracer?: Tracer;
  readonly traceAttributes?: TraceAttributes;
  readonly signal?: AbortSignal;
  /** Required for endpoints with auth.type=oauth; credentials stay outside configuration. */
  readonly oauth?: McpOAuthManager;
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };
}

export interface McpToolOutput {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
}

export interface McpDiagnostic {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  /** Sanitized, bounded recent stderr. It is never added to tracing spans. */
  readonly stderr?: string;
}

export type McpServerConnectionState =
  | "connected"
  | "auth-required"
  | "failed"
  | "disconnected";

export interface McpServerStatus {
  readonly serverId: string;
  readonly transport: McpTransport;
  readonly protocolVersion?: string;
  readonly required: boolean;
  readonly state: McpServerConnectionState;
  readonly toolNames: readonly string[];
  /** Sanitized, bounded recent stderr, including non-fatal server logs. */
  readonly stderr?: string;
  readonly diagnostic?: McpDiagnostic;
}

interface McpClientEventBase {
  readonly seq: number;
  readonly timestamp: number;
  readonly serverId: string;
  readonly transport: McpTransport;
  readonly required: boolean;
}

export type McpClientEvent =
  | McpClientEventBase & {
      readonly type: "mcp.server.connected";
      readonly toolNames: readonly string[];
    }
  | McpClientEventBase & {
      readonly type: "mcp.server.failed";
      readonly diagnostic: McpDiagnostic;
    }
  | McpClientEventBase & {
      readonly type: "mcp.server.disconnected";
    };

export interface McpClientPool {
  /** Startup snapshot of all tools exposed by the configured servers. */
  readonly tools: readonly Tool[];
  /** Best-effort lifecycle events; startup events are buffered until consumed. */
  readonly events: AsyncIterable<McpClientEvent>;
  /** Current status snapshot, including configured optional servers that failed. */
  status(): readonly McpServerStatus[];
  close(): Promise<void>;
}
