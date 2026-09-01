import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolDefinition,
} from "@may/provider-openai-compatible";

export interface ZhipuChatRequest {
  model: string;
  messages: OpenAICompatibleMessage[];
  stream: true;
  thinking: {
    type: "enabled" | "disabled";
    clear_thinking?: boolean;
  };
  reasoning_effort?: string;
  max_tokens?: number;
  tools?: OpenAICompatibleToolDefinition[];
  tool_stream?: true;
}
