import type {
  ContentPart,
  MediaSource,
  Message,
  ModelState,
  ToolDefinition,
} from "@may/core";
import { UnsupportedContentError } from "@may/core";

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
        content: toInputContent(message.content, "user"),
      });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: hasMedia(message.content)
          ? toInputContent(message.content, "tool")
          : visibleText(message.content, "tool"),
      });
      continue;
    }

    const native = nativeItems(message.modelState);
    if (native !== undefined) {
      input.push(...native);
      continue;
    }

    const text = visibleText(message.content, "assistant");
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

function toInputContent(
  content: readonly ContentPart[],
  role: "user" | "tool",
): unknown[] {
  return content.flatMap<unknown>((part) => {
    if (part.type === "reasoning") return [];
    if (part.type === "text") {
      return [{ type: "input_text", text: part.text }];
    }
    if (part.type === "json") {
      return [{ type: "input_text", text: serializeJson(part.value) }];
    }
    if (part.type === "image") {
      const source = toOpenAIImageSource(part.source);
      return [{
        type: "input_image",
        ...source,
        ...(part.detail === undefined ? {} : { detail: part.detail }),
      }];
    }
    if (part.type === "file") {
      return [{ type: "input_file", ...toOpenAIFileSource(part.source, part.name) }];
    }
    throw new UnsupportedContentError("OpenAI Responses adapter", part.type, role);
  });
}

function visibleText(
  content: readonly ContentPart[],
  role: Message["role"] = "system",
): string {
  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return serializeJson(part.value);
      throw new UnsupportedContentError("OpenAI Responses adapter", part.type, role);
    })
    .join("\n");
}

function hasMedia(content: readonly ContentPart[]): boolean {
  return content.some((part) => part.type === "image" || part.type === "file");
}

function toOpenAIImageSource(
  source: MediaSource,
): { image_url: string } | { file_id: string } {
  if (source.type === "url") return { image_url: source.url };
  if (source.type === "file") return { file_id: source.fileId };
  return {
    image_url: `data:${source.mediaType};base64,${source.data}`,
  };
}

function toOpenAIFileSource(
  source: MediaSource,
  name: string | undefined,
): { file_url: string } | { file_id: string } | {
  filename: string;
  file_data: string;
} {
  if (source.type === "url") return { file_url: source.url };
  if (source.type === "file") return { file_id: source.fileId };
  return {
    filename: name ?? "file",
    file_data: `data:${source.mediaType};base64,${source.data}`,
  };
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
