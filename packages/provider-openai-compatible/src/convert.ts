import type {
  ContentPart,
  Message,
  ToolCall,
  ToolDefinition,
} from "@may/core";
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolCall,
  OpenAICompatibleToolDefinition,
} from "./protocol.js";

export function toOpenAICompatibleMessages(
  messages: Message[],
): OpenAICompatibleMessage[] {
  return messages.map((message) => {
    if (message.role === "system" || message.role === "user") {
      return {
        role: message.role,
        content: serializeVisibleContent(message.content),
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: serializeVisibleContent(message.content),
      };
    }

    const converted: Extract<
      OpenAICompatibleMessage,
      { role: "assistant" }
    > = {
      role: "assistant",
      content: serializeVisibleContent(message.content),
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
  tools: ToolDefinition[],
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

function serializeVisibleContent(content: ContentPart[]): string {
  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => part.type === "text" ? part.text : serializeJson(part.value))
    .join("\n");
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}
