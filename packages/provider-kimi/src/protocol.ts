import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolDefinition,
} from "@may/provider-openai-compatible";

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
  reasoning_effort?: "low" | "high" | "max";
  max_completion_tokens?: number;
}
