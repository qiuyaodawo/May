import type { ContentPart, RunBudget } from "@may/core";
import type { ApprovalDecision, ApprovalRequest } from "@may/permissions";
import type { PluginModuleSelection } from "@may/plugin";
import type { AgentAdapter as GatewayAgentAdapter, AgentAdapterContext as GatewayAdapterContext, AgentCapabilities as GatewayCapabilities, AgentTaskStatus as GatewayTaskStatus } from "@may/plugin-agent-adapters";
export type { GatewayAgentAdapter, GatewayAdapterContext, GatewayCapabilities, GatewayTaskStatus };

export type GatewayActor = { kind: "operator"; id: string } | {
  kind: "platform"; account: string; userId: string; conversation: string; threadId?: string;
};
export interface GatewayEntry {
  account: string;
  conversation: string;
  kind: "private" | "group";
  owner?: string;
  threadId?: string;
}
export interface GatewaySession {
  id: string;
  name: string;
  entry?: GatewayEntry;
  defaultAgents: string[];
  allowedAgents: string[];
  status: "active" | "archived" | "deleting";
  createdAt: number;
  updatedAt: number;
}
export interface GatewayBinding {
  id: string;
  sessionId: string;
  agentId: string;
  conversationId?: string;
  requestId: string;
  version: string;
  status: "creating" | "ready" | "unknown" | "deleting";
  error?: string;
  usedAt: number;
}
export interface GatewayMessage {
  id: string;
  sessionId: string;
  seq: number;
  kind: "user" | "assistant" | "notice";
  text: string;
  createdAt: number;
  actor?: GatewayActor;
  agentId?: string;
  taskId?: string;
  sourceMessageId?: string;
  sourceEntry?: string;
  content?: ContentPart[];
}
export interface GatewayTask {
  id: string;
  sessionId: string;
  agentId: string;
  graphId: string;
  graphTaskId: string;
  actor: GatewayActor;
  input: string;
  inputId: string;
  status: GatewayTaskStatus;
  createdAt: number;
  updatedAt: number;
  runId?: string;
  result?: string;
  detail?: string;
}
export interface GatewayApproval {
  id: string;
  sessionId: string;
  agentId: string;
  taskId?: string;
  requestId: string;
  kind: "create-agent" | "tool";
  status: "pending" | "resolving" | "unknown" | "allowed" | "denied" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number;
  grantKey?: string;
  persistent?: NonNullable<ApprovalRequest["persistent"]>;
  text: string;
  actor: GatewayActor;
  decidedBy?: GatewayActor;
  decision?: ApprovalDecision;
}
export interface GatewayAgentConfig {
  id: string;
  name?: string;
  adapter: "may" | "module";
  enabled?: boolean;
  model?: string;
  instructions?: string;
  readDirectory?: string;
  module?: string;
  export?: string;
  options?: Record<string, unknown>;
  plugins?: readonly PluginModuleSelection[];
  idleMs?: number;
  runBudget?: RunBudget;
  permissions?: Record<string, "allow" | "deny" | "ask">;
  media?: string[];
}
export interface GatewaySettings {
  version: 2;
  persistentRules?: boolean;
  publicOrigin?: string;
  agents: GatewayAgentConfig[];
  access: {
    sessionAdmins: Record<string, string[]>;
    creators: string[];
    deniedUsers: string[];
    allowedAgents: Record<string, string[]>;
  };
  idleMs: number;
  shutdownMs: number;
  approvalMs: number;
  maxConcurrent: number;
}
export interface GatewayDelivery {
  id: string;
  sessionId: string;
  messageId: string;
  entry: GatewayEntry;
  text: string;
  status: "pending" | "sending" | "sent" | "unknown" | "failed";
  after?: string;
  replyTo?: string;
  platformMessageId?: string;
  image?: Extract<ContentPart, { type: "image" }>;
}

export function actorKey(actor: GatewayActor): string {
  return actor.kind === "operator" ? `operator:${actor.id}` : `${actor.account}:${actor.userId}`;
}
export function entryKey(entry: Pick<GatewayEntry, "account" | "conversation" | "threadId">): string {
  return JSON.stringify([entry.account, entry.conversation, entry.threadId ?? null]);
}
