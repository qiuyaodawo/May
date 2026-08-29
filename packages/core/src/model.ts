import type {
  AssistantMessage,
  JsonSchema,
  Message,
  Usage,
} from "./types.js";
import type { ContextSnapshot } from "./context.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  metadata?: Record<string, unknown>;
}

export interface ModelLimits {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelContextCompactionResult {
  readonly messages: readonly Message[];
  /** Provider-supplied effective size of the compacted model input. */
  readonly effectiveTokens?: number;
}

export interface ModelContextCompactor {
  readonly name: string;
  compact(
    snapshot: Readonly<ContextSnapshot>,
    options: { readonly signal?: AbortSignal; readonly runId?: string; readonly step?: number },
  ): Promise<ModelContextCompactionResult>;
}

export type ModelEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | {
      type: "response.completed";
      message: AssistantMessage;
      usage?: Usage;
    };

export interface Model {
  readonly limits?: ModelLimits;
  /** Optional provider-native context compaction capability. */
  readonly contextCompactor?: ModelContextCompactor;
  stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent>;
}
