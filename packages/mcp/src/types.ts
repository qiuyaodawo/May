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
  /** Per-request inactivity timeout. The SDK default is 60 seconds. */
  readonly requestTimeoutMs?: number;
  /** Absolute upper bound for a request, including progress notifications. */
  readonly maxTotalTimeoutMs?: number;
  /** Maximum size of one protocol message. The SDK default is 10 MiB. */
  readonly maxBufferSize?: number;
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

export interface McpClientPool {
  /** Startup snapshot of all tools exposed by the configured servers. */
  readonly tools: readonly Tool[];
  close(): Promise<void>;
}
