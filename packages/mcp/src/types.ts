import type { CompleteRequestParams, CompleteResult, GetPromptResult, ReadResourceResult, Prompt, Resource, ResourceTemplateType, ServerCapabilities, Tool as ProtocolTool } from "@modelcontextprotocol/client";
import type {
  Tool,
  TraceAttributes,
  TraceContext,
  Tracer,
} from "@may/core";
import type { McpOAuthManager, McpOAuthOptions } from "./oauth.js";
import type { McpInteractionBroker, McpInteractionOwner } from "./interactions.js";

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
  /** Opt-in ephemeral host UI broker. Omission leaves elicitation unadvertised. */
  readonly interactions?: McpInteractionBroker;
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
  readonly _meta?: Readonly<Record<string, unknown>> | undefined;
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
  readonly catalogRevision?: number;
  readonly catalogStale?: boolean;
  readonly catalogSubscription?: "active" | "partial" | "unavailable" | "legacy" | "not-advertised";
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

export interface McpServerCatalog {
  readonly serverId: string;
  readonly revision: number;
  readonly capabilities: ServerCapabilities;
  readonly tools: readonly ProtocolTool[];
  readonly resources: readonly Resource[];
  readonly resourceTemplates: readonly ResourceTemplateType[];
  readonly prompts: readonly Prompt[];
}

export type McpClientEvent =
  | McpClientEventBase & {
      readonly type: "mcp.server.connected";
      readonly toolNames: readonly string[];
    }
  | McpClientEventBase & {
      readonly type: "mcp.server.catalog-updated";
      readonly revision: number;
      readonly toolNames: readonly string[];
    }
  | McpClientEventBase & {
      readonly type: "mcp.server.failed";
      readonly diagnostic: McpDiagnostic;
    }
  | McpClientEventBase & {
      readonly type: "mcp.server.disconnected";
    };

export interface McpOperationOptions {
  readonly owner?: McpInteractionOwner;
  readonly signal?: AbortSignal;
  readonly traceContext?: TraceContext;
}

export interface McpReadOptions extends McpOperationOptions {
  readonly cache?: "use" | "refresh" | "bypass";
}

export interface McpResourceRead {
  readonly serverId: string;
  readonly uri: string;
  readonly result: ReadResourceResult;
  readonly fromCache: boolean;
}

export interface McpPromptExpansion {
  readonly serverId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly result: GetPromptResult;
}

export type McpCompletionParams = Pick<CompleteRequestParams, "ref" | "argument" | "context">;
export type McpCompletion = CompleteResult["completion"];

export interface McpResourceSubscription {
  readonly serverId: string;
  readonly uri: string;
  /** Notification only. Updated data is never loaded or attached automatically. */
  readonly events: AsyncIterable<{ readonly type: "updated"; readonly serverId: string; readonly uri: string }>;
  readonly closed: Promise<"local" | "remote" | "connection-closed">;
  close(): Promise<void>;
}

export interface McpClientPool {
  /** Pool-owned, ephemeral UI broker when explicitly enabled. Do not share between pools. */
  readonly interactions?: McpInteractionBroker | undefined;
  /** Latest immutable tool catalog; use toolSource: () => pool.tools for per-Run updates. */
  readonly tools: readonly Tool[];
  /** Best-effort lifecycle events; startup events are buffered until consumed. */
  readonly events: AsyncIterable<McpClientEvent>;
  /** Current status snapshot, including configured optional servers that failed. */
  status(): readonly McpServerStatus[];
  /** Metadata only, never fetches resource contents or expands prompts. */
  catalog(): readonly McpServerCatalog[];
  /** Refresh discovery, never replay tool operations. Omit serverId for all endpoints. */
  refresh(serverId?: string, signal?: AbortSignal): Promise<void>;
  /** Explicitly replace a connection; rejects while an operation is in flight. */
  reconnect(serverId: string, signal?: AbortSignal): Promise<void>;
  /** Host/user operations, not automatically exported to the model as tools. */
  readResource(serverId: string, uri: string, options?: McpReadOptions): Promise<McpResourceRead>;
  readResourceTemplate(serverId: string, template: string, variables: Readonly<Record<string, string | string[]>>, options?: McpReadOptions): Promise<McpResourceRead>;
  getPrompt(serverId: string, name: string, args?: Readonly<Record<string, string>>, options?: McpOperationOptions): Promise<McpPromptExpansion>;
  complete(serverId: string, params: McpCompletionParams, options?: McpOperationOptions): Promise<McpCompletion>;
  subscribeResource(serverId: string, uri: string, options?: McpOperationOptions): Promise<McpResourceSubscription>;
  close(): Promise<void>;
}
