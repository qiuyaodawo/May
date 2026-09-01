import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolDefinition,
} from "@may/provider-openai-compatible";

export interface DeepSeekChatRequest {
  model: string;
  messages: OpenAICompatibleMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAICompatibleToolDefinition[];
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: string;
  max_tokens?: number;
}
