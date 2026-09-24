import type { AgentApplicationEvent } from "@may/application";
import type { ContentPart, RunBudget, Tool, UserMessage } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";

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
export type GatewayTaskStatus = "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | "recovery-required";
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
  text: string;
  actor: GatewayActor;
  decidedBy?: GatewayActor;
  decision?: ApprovalDecision;
}
export interface GatewayCapabilities {
  cancel: boolean;
  steer: boolean;
  resume: boolean;
  delete: boolean;
  approvals: boolean;
  collaboration: boolean;
  media: readonly string[];
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
  idleMs?: number;
  runBudget?: RunBudget;
  permissions?: Record<string, "allow" | "deny" | "ask">;
  media?: string[];
}
export interface GatewayAdapterContext {
  conversationId: string;
  inputId: string;
  input: UserMessage;
  signal: AbortSignal;
  tools: readonly Tool[];
  shouldYield: () => boolean;
  report: (event: AgentApplicationEvent) => void;
}
export interface GatewayAgentAdapter {
  readonly capabilities: GatewayCapabilities;
  createConversation(requestId: string): Promise<string>;
  inspectCreation?(requestId: string): Promise<{ status: "not-started" | "ready" | "unknown"; conversationId?: string }>;
  execute(context: GatewayAdapterContext): Promise<{ text: string; runId?: string; yielded?: boolean; content?: ContentPart[] }>;
  inspect(conversationId: string, inputId: string): Promise<{ status: "not-started" | GatewayTaskStatus; text?: string; detail?: string; content?: ContentPart[]; runId?: string }>;
  cancel?(conversationId: string): Promise<void>;
  steer?(conversationId: string, text: string, inputId: string): Promise<{ status: string }>;
  steeringInputs?(conversationId: string): Promise<readonly { inputId: string; text: string; status: string }[]>;
  resolveApproval?(conversationId: string, requestId: string, decision: ApprovalDecision): Promise<boolean>;
  release?(conversationId: string): Promise<void>;
  deleteConversation?(conversationId: string): Promise<void>;
  command?(conversationId: string, name: string, args: readonly string[]): Promise<string>;
  close(): Promise<void>;
}
export interface GatewaySettings {
  version: 2;
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
