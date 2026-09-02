import type {
  ContentPart,
  MediaSource,
  Message,
  ModelState,
  ToolDefinition,
} from "@may/core";
import { UnsupportedContentError } from "@may/core";
import { AnthropicProtocolError } from "./errors.js";
import {
  ANTHROPIC_MODEL_STATE_TYPE,
  type AnthropicAssistantContentBlock,
  type AnthropicMessagesRequest,
  type AnthropicMediaSource,
  type AnthropicModelStateData,
  type AnthropicRequestMessage,
  type AnthropicTextBlock,
  type AnthropicUserContentBlock,
  type AnthropicThinkingConfig,
  type AnthropicToolDefinition,
  type AnthropicToolResultBlock,
} from "./protocol.js";

export interface AnthropicRequestParts {
  messages: AnthropicRequestMessage[];
  system?: string;
}

export function toAnthropicRequestParts(
  messages: readonly Message[],
): AnthropicRequestParts {
  const system: string[] = [];
  const converted: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = serializeVisibleContent(message.content);
      if (text !== "") system.push(text);
      continue;
    }

    if (message.role === "user") {
      converted.push({
        role: "user",
        content: toUserBlocks(message.content),
      });
      continue;
    }

    if (message.role === "tool") {
      const toolResult: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: hasMedia(message.content)
          ? toUserBlocks(message.content)
          : serializeVisibleContent(message.content, "tool"),
      };
      if (message.isError !== undefined) {
        toolResult.is_error = message.isError;
      }
      converted.push({ role: "user", content: [toolResult] });
      continue;
    }

    const nativeContent = getAnthropicStateContent(message.modelState);
    if (nativeContent !== undefined) {
      converted.push({ role: "assistant", content: nativeContent });
      continue;
    }

    const content: AnthropicAssistantContentBlock[] = [
      ...toAssistantTextBlocks(message.content),
    ];
    for (const call of message.toolCalls ?? []) {
      if (!isRecord(call.input)) {
        throw new AnthropicProtocolError(
          `Anthropic tool call "${call.name}" input must be an object`,
        );
      }
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
    converted.push({ role: "assistant", content });
  }

  const result: AnthropicRequestParts = { messages: converted };
  if (system.length > 0) result.system = system.join("\n");
  return result;
}

export function toAnthropicTools(
  tools: readonly ToolDefinition[],
): AnthropicToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function toAnthropicThinking(
  thinking: AnthropicThinkingConfig,
): NonNullable<AnthropicMessagesRequest["thinking"]> {
  if (thinking.type === "enabled") {
    const converted: Extract<
      NonNullable<AnthropicMessagesRequest["thinking"]>,
      { type: "enabled" }
    > = {
      type: "enabled",
      budget_tokens: thinking.budgetTokens,
    };
    if (thinking.display !== undefined) converted.display = thinking.display;
    return converted;
  }

  if (thinking.type === "adaptive") {
    const converted: Extract<
      NonNullable<AnthropicMessagesRequest["thinking"]>,
      { type: "adaptive" }
    > = { type: "adaptive" };
    if (thinking.display !== undefined) converted.display = thinking.display;
    return converted;
  }

  return { type: "disabled" };
}

function getAnthropicStateContent(
  state: ModelState | undefined,
): AnthropicAssistantContentBlock[] | undefined {
  if (state?.type !== ANTHROPIC_MODEL_STATE_TYPE) return undefined;
  if (!isRecord(state.data) || !Array.isArray(state.data.content)) {
    throw new AnthropicProtocolError("Anthropic model state is malformed");
  }

  return (state.data as unknown as AnthropicModelStateData).content;
}

function toAssistantTextBlocks(content: ContentPart[]): AnthropicTextBlock[] {
  return content.flatMap((part) => {
    if (part.type === "reasoning") return [];
    if (part.type !== "text" && part.type !== "json") {
      throw new UnsupportedContentError("Anthropic adapter", part.type, "assistant");
    }
    return [{
      type: "text" as const,
      text: part.type === "text" ? part.text : serializeJson(part.value),
    }];
  });
}

function toUserBlocks(content: ContentPart[]): AnthropicUserContentBlock[] {
  return content.flatMap<AnthropicUserContentBlock>((part) => {
    if (part.type === "reasoning") return [];
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "json") {
      return [{ type: "text", text: serializeJson(part.value) }];
    }
    if (part.type === "image") {
      return [{ type: "image", source: toAnthropicSource(part.source) }];
    }
    if (part.type === "file") {
      return [{ type: "document", source: toAnthropicSource(part.source) }];
    }
    throw new UnsupportedContentError("Anthropic adapter", part.type, "user");
  });
}

function serializeVisibleContent(
  content: ContentPart[],
  role: Message["role"] = "system",
): string {
  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return serializeJson(part.value);
      throw new UnsupportedContentError("Anthropic adapter", part.type, role);
    })
    .join("\n");
}

function hasMedia(content: readonly ContentPart[]): boolean {
  return content.some((part) => part.type === "image" || part.type === "file");
}

function toAnthropicSource(source: MediaSource): AnthropicMediaSource {
  if (source.type === "url") return { type: "url", url: source.url };
  if (source.type === "file") return { type: "file", file_id: source.fileId };
  return {
    type: "base64",
    media_type: source.mediaType,
    data: source.data,
  };
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
