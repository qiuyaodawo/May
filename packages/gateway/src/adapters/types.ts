import type { AgentApplicationEvent } from "@sortedyuan/may";
import type { ContentPart, Tool, UserMessage } from "@sortedyuan/may/core";
import type { ApprovalDecision, PersistentApprovalOptions } from "@sortedyuan/may/permissions";

/** @experimental */
export type AgentTaskStatus =
  "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | "recovery-required";
/** @experimental */
export interface AgentCapabilities {
  cancel: boolean;
  steer: boolean;
  resume: boolean;
  delete: boolean;
  approvals: boolean;
  collaboration: boolean;
  media: readonly string[];
}
/** @experimental */
export interface AgentAdapterContext {
  readonly telemetry?: import("@sortedyuan/may/core").TelemetryCorrelation;
  conversationId: string;
  inputId: string;
  input: UserMessage;
  signal: AbortSignal;
  tools: readonly Tool[];
  shouldYield: () => boolean;
  report: (event: AgentApplicationEvent) => void;
  readonly permissionScope?: string;
}
/** @experimental */
export interface AgentAdapter {
  readonly capabilities: AgentCapabilities;
  modelCapabilities?(refresh?: boolean): Promise<unknown>;
  diagnostics?(conversationId: string, query?: { readonly limit?: number; readonly offset?: number }): unknown;
  createConversation(requestId: string): Promise<string>;
  inspectCreation?(
    requestId: string,
  ): Promise<{ status: "not-started" | "ready" | "unknown"; conversationId?: string }>;
  execute(
    context: AgentAdapterContext,
  ): Promise<{ text: string; runId?: string; yielded?: boolean; content?: ContentPart[] }>;
  inspect(
    conversationId: string,
    inputId: string,
  ): Promise<{
    status: "not-started" | AgentTaskStatus;
    text?: string;
    detail?: string;
    content?: ContentPart[];
    runId?: string;
  }>;
  cancel?(conversationId: string): Promise<void>;
  steer?(conversationId: string, text: string, inputId: string): Promise<{ status: string }>;
  steeringInputs?(conversationId: string): Promise<readonly { inputId: string; text: string; status: string }[]>;
  resolveApproval?(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision,
    options?: PersistentApprovalOptions,
  ): Promise<boolean>;
  release?(conversationId: string): Promise<void>;
  deleteConversation?(conversationId: string): Promise<void>;
  command?(conversationId: string, name: string, args: readonly string[]): Promise<string>;
  close(): Promise<void>;
}
/** @experimental */
export interface AgentAdapterConfig {
  readonly id: string;
  readonly module: string;
  readonly export?: string;
  readonly options?: Record<string, unknown>;
}
/** @experimental */
export interface AgentAdapterRegistry {
  get(id: string): Promise<AgentAdapter>;
  release(id: string): Promise<void>;
  list(): readonly string[];
}
/** @experimental */
export type GatewayAgentAdapter = AgentAdapter;
/** @experimental */
export type GatewayAdapterContext = AgentAdapterContext;
/** @experimental */
export type GatewayCapabilities = AgentCapabilities;
/** @experimental */
export type GatewayTaskStatus = AgentTaskStatus;
