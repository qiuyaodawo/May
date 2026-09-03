import type {
  Tool,
  TraceAttributes,
  Tracer,
} from "@may/core";

export interface McpStdioServerOptions {
  /** Stable configuration id used to namespace every remote tool. */
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Explicit child-process environment additions. Values are never traced. */
  readonly env?: Readonly<Record<string, string>>;
  /** Whether failure to start this server aborts the whole pool. Defaults to true. */
  readonly required?: boolean;
  /** Per-request inactivity timeout. The SDK default is 60 seconds. */
  readonly requestTimeoutMs?: number;
  /** Absolute upper bound for a request, including progress notifications. */
  readonly maxTotalTimeoutMs?: number;
  /** Maximum size of one protocol message. The SDK default is 10 MiB. */
  readonly maxBufferSize?: number;
  /** Retained tail of stderr used for diagnostics. Defaults to 16 KiB. */
  readonly stderrMaxBytes?: number;
}

export interface OpenMcpClientPoolOptions {
  readonly servers: readonly McpStdioServerOptions[];
  readonly tracer?: Tracer;
  readonly traceAttributes?: TraceAttributes;
  readonly signal?: AbortSignal;
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
  | "failed"
  | "disconnected";

export interface McpServerStatus {
  readonly serverId: string;
  readonly transport: "stdio";
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
  readonly transport: "stdio";
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
