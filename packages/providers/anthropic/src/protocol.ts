import type { JsonSchema } from "@may/core";

export const ANTHROPIC_MODEL_STATE_TYPE =
  "@may/provider-anthropic/message-v1";

export type AnthropicReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AnthropicThinkingConfig =
  | {
      type: "enabled";
      budgetTokens: number;
      display?: "summarized" | "omitted";
    }
  | {
      type: "adaptive";
      display?: "summarized" | "omitted";
    }
  | { type: "disabled" };

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: Array<
    AnthropicAssistantContentBlock | AnthropicToolResultBlock
  >;
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface AnthropicModelStateData {
  messageId: string;
  content: AnthropicAssistantContentBlock[];
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicRequestMessage[];
  stream: true;
  system?: string;
  tools?: AnthropicToolDefinition[];
  thinking?:
    | {
        type: "enabled";
        budget_tokens: number;
        display?: "summarized" | "omitted";
      }
    | {
        type: "adaptive";
        display?: "summarized" | "omitted";
      }
    | { type: "disabled" };
  output_config?: { effort: AnthropicReasoningEffort };
}
