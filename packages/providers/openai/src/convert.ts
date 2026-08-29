import type {
  ContentPart,
  Message,
  ModelState,
  ToolDefinition,
} from "@may/core";

import { OpenAIResponsesProtocolError } from "./errors.js";
import {
  OPENAI_RESPONSES_MODEL_STATE_TYPE,
  type OpenAIResponsesModelStateData,
} from "./protocol.js";

export interface OpenAIResponsesRequestParts {
  readonly input: unknown[];
  readonly instructions?: string;
}

export function toOpenAIResponsesRequestParts(
  messages: readonly Message[],
  baseInstructions?: string,
): OpenAIResponsesRequestParts {
  const instructions: string[] = [];
  if (baseInstructions?.trim()) instructions.push(baseInstructions);
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = visibleText(message.content);
      if (text !== "") instructions.push(text);
      continue;
    }
    if (message.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: visibleText(message.content) }],
      });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: visibleText(message.content),
      });
      continue;
    }

    const native = nativeItems(message.modelState);
    if (native !== undefined) {
      input.push(...native);
      continue;
    }

    const text = visibleText(message.content);
    if (text !== "") {
      input.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: serializeJson(call.input),
        status: "completed",
      });
    }
  }

  return {
    input,
    ...(instructions.length === 0
      ? {}
      : { instructions: instructions.join("\n\n") }),
  };
}

export function toOpenAIResponsesTools(
  tools: readonly ToolDefinition[],
): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

function nativeItems(state: ModelState | undefined): unknown[] | undefined {
  if (state?.type !== OPENAI_RESPONSES_MODEL_STATE_TYPE) return undefined;
  if (!isRecord(state.data) || !Array.isArray(state.data.items)) {
    throw new OpenAIResponsesProtocolError(
      "OpenAI Responses model state is malformed",
    );
  }
  return [...(state.data as unknown as OpenAIResponsesModelStateData).items];
}

function visibleText(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => part.type === "text" ? part.text : serializeJson(part.value))
    .join("\n");
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
