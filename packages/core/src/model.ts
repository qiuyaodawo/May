import type {
  AssistantMessage,
  JsonSchema,
  Message,
  Usage,
} from "./types.js";

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
  stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent>;
}
