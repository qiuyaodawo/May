import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolDefinition,
} from "../openai-compatible/index.js";

export interface KimiThinkingConfig {
  type: "enabled" | "disabled";
  keep?: "all" | null;
}

export interface KimiChatRequest {
  model: string;
  messages: OpenAICompatibleMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAICompatibleToolDefinition[];
  thinking?: KimiThinkingConfig;
  reasoning_effort?: string;
  max_completion_tokens?: number;
}
