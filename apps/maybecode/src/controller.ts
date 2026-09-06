import type { AgentWorkspaceController } from "@may/application";
import type { ContextCompactionStrategy } from "@may/context";
import type { McpClientPool, McpServerStatus, McpResourceSubscription, McpInteractionBroker } from "@may/mcp";
import type { MaybeCodeEvent, MaybeCodeSessionEvent } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export interface MaybeCodeModelInfo {
  readonly profile?: string;
  readonly provider: string;
  readonly adapter?: string;
  readonly model: string;
}

export interface MaybeCodeModelProfile {
  readonly name: string;
  readonly provider: string;
  readonly adapter: string;
  readonly model: string;
  readonly isDefault: boolean;
  /** Effort configured by provider/model options before runtime overrides. */
  readonly reasoningEffort?: string;
}

export interface MaybeCodeReasoningEffortState {
  readonly status: "known" | "unsupported" | "unknown";
  readonly source: "user" | "provider" | "builtin" | "unknown";
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly effectiveEffort?: string;
  readonly overridden: boolean;
}

export type MaybeCodeCompactionStrategyName =
  | "prune-old-tool-results"
  | "summary-tail"
  | "history-reference";

export type MaybeCodeCompactionSelection =
  | MaybeCodeCompactionStrategyName
  | ContextCompactionStrategy;

/**
 * Headless MaybeCode control surface for terminal, graphical, or remote UIs.
 *
 * A UI sends user intents through these methods and observes asynchronous
 * runtime changes through `events`. It does not depend on readline, ANSI
 * rendering, or the concrete workspace implementation.
 */
type MaybeCodeProductEvent = Extract<
  MaybeCodeEvent,
  | { type: "model.changed" }
  | { type: "model.default.changed" }
  | { type: "mcp.resource.updated" }
  | { type: "mcp.resource.watch-closed" }
  | { type: "mcp.server.connected" }
  | { type: "mcp.interaction.requested" }
  | { type: "mcp.interaction.settled" }
  | { type: "mcp.server.catalog-updated" }
  | { type: "mcp.server.failed" }
  | { type: "mcp.server.disconnected" }
>;

export interface MaybeCodeController extends AgentWorkspaceController<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection
> {
  readonly instructions: MaybeCodeInstructions;
  readonly modelInfo: MaybeCodeModelInfo | undefined;

  getMcpStatus(): Promise<readonly McpServerStatus[]>;
  getMcpInteractions?(): ReturnType<McpInteractionBroker["list"]>;
  respondMcpInteraction?(id: string, response: Parameters<McpInteractionBroker["respond"]>[2]): boolean;
  refreshMcp?(serverId?: string): Promise<void>;
  reconnectMcp?(serverId: string): Promise<void>;
  getMcpCatalog?: McpClientPool["catalog"];
  readMcpResource?: McpClientPool["readResource"];
  readMcpResourceTemplate?: McpClientPool["readResourceTemplate"];
  getMcpPrompt?: McpClientPool["getPrompt"];
  completeMcp?: McpClientPool["complete"];
  watchMcpResource?(serverId: string, uri: string): Promise<McpResourceSubscription>;
  unwatchMcpResource?(serverId: string, uri: string): Promise<void>;
  submitMcpResource?(serverId: string, uri: string, instruction?: string): Promise<import("./events.js").MaybeCodeRun>;
  submitMcpPrompt?(serverId: string, name: string, args?: Readonly<Record<string, string>>): Promise<import("./events.js").MaybeCodeRun>;
  listModels(): Promise<readonly MaybeCodeModelProfile[]>;
  switchModel(profile: string): Promise<MaybeCodeModelInfo>;
  /** Persist the profile used by future launches without switching models. */
  setDefaultModel(profile: string): Promise<void>;
  getReasoningEffort(): Promise<MaybeCodeReasoningEffortState>;
  /** Set an active-profile override, or clear it with undefined. */
  setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState>;
}
