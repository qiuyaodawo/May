import type { JsonSchema } from "@sortedyuan/may/core";

/** @experimental */
export const ANTHROPIC_MODEL_STATE_TYPE = "@may/provider-anthropic/message-v1";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type AnthropicReasoningEffort = string;

/** @experimental */
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
  citations?: Record<string, unknown>[];
  cache_control?: AnthropicCacheControl;
  type: "text";
  text: string;
}

export type AnthropicMediaSource =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string }
  | { type: "file"; file_id: string };

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicMediaSource;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: AnthropicMediaSource;
}

export type AnthropicUserContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock;

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
  | AnthropicToolUseBlock
  | AnthropicServerToolBlock;

export interface AnthropicServerToolBlock {
  type: "server_tool_use" | `${string}_tool_result`;
  [key: string]: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicUserContentBlock[];
  is_error?: boolean;
}

export interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: Array<
    AnthropicAssistantContentBlock | AnthropicToolResultBlock | AnthropicImageBlock | AnthropicDocumentBlock
  >;
}

export interface AnthropicToolDefinition {
  cache_control?: AnthropicCacheControl;
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** @experimental */
export interface AnthropicModelStateData {
  origin?: import("../web-search.js").ServerToolOrigin;
  container?: unknown;
  messageId: string;
  content: AnthropicAssistantContentBlock[];
}

export interface AnthropicMessagesRequest {
  cache_control?: AnthropicCacheControl;
  model: string;
  max_tokens: number;
  messages: AnthropicRequestMessage[];
  stream: true;
  system?: string | AnthropicTextBlock[];
  tools?: (
    | AnthropicToolDefinition
    | ({ type: string; name: string; cache_control?: AnthropicCacheControl } & Record<string, unknown>)
  )[];
  container?: string;
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

export interface AnthropicCacheControl {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}
