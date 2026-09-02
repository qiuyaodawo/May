import type {
  ContentPart,
  MediaSource,
  Message,
  ToolCall,
  ToolDefinition,
} from "@may/core";
import { UnsupportedContentError } from "@may/core";
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolCall,
  OpenAICompatibleToolDefinition,
} from "./protocol.js";

export function toOpenAICompatibleMessages(
  messages: readonly Message[],
  options: { includeToolName?: boolean } = {},
): OpenAICompatibleMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      return {
        role: "system",
        content: serializeVisibleContent(message.content, "system"),
      };
    }

    if (message.role === "user") {
      return { role: "user", content: toUserContent(message.content) };
    }

    if (message.role === "tool") {
      const converted: Extract<
        OpenAICompatibleMessage,
        { role: "tool" }
      > = {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: serializeVisibleContent(message.content, "tool"),
      };
      if (options.includeToolName) converted.name = message.name;
      return converted;
    }

    const converted: Extract<
      OpenAICompatibleMessage,
      { role: "assistant" }
    > = {
      role: "assistant",
      content: serializeVisibleContent(message.content, "assistant"),
    };
    const reasoningParts = message.content.filter(
      (part) => part.type === "reasoning",
    );

    if (reasoningParts.length > 0) {
      converted.reasoning_content = reasoningParts
        .map((part) => part.text)
        .join("");
    }
    if (message.toolCalls !== undefined) {
      converted.tool_calls = message.toolCalls.map(convertToolCall);
    }

    return converted;
  });
}

export function toOpenAICompatibleTools(
  tools: readonly ToolDefinition[],
): OpenAICompatibleToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function convertToolCall(call: ToolCall): OpenAICompatibleToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: serializeJson(call.input),
    },
  };
}

function toUserContent(
  content: ContentPart[],
): Extract<OpenAICompatibleMessage, { role: "user" }>["content"] {
  const hasImages = content.some((part) => part.type === "image");
  if (!hasImages) return serializeVisibleContent(content, "user");

  return content.flatMap<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } }
  >((part) => {
    if (part.type === "reasoning") return [];
    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
    if (part.type === "json") {
      return [{ type: "text" as const, text: serializeJson(part.value) }];
    }
    if (part.type === "image") {
      const imageUrl = imageSourceUrl(part.source);
      return [{
        type: "image_url" as const,
        image_url: {
          url: imageUrl,
          ...(part.detail === undefined ? {} : { detail: part.detail }),
        },
      }];
    }
    throw new UnsupportedContentError(
      "OpenAI-compatible chat adapter",
      part.type,
      "user",
    );
  });
}

function serializeVisibleContent(
  content: ContentPart[],
  role: Message["role"],
): string {
  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return serializeJson(part.value);
      throw new UnsupportedContentError(
        "OpenAI-compatible chat adapter",
        part.type,
        role,
      );
    })
    .join("\n");
}

function imageSourceUrl(source: MediaSource): string {
  if (source.type === "url") return source.url;
  if (source.type === "base64") {
    return `data:${source.mediaType};base64,${source.data}`;
  }
  throw new UnsupportedContentError(
    "OpenAI-compatible chat adapter",
    "image file-id source",
    "user",
  );
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}
