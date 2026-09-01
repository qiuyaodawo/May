import type {
  AssistantMessage,
  ContentPart,
  ModelEvent,
  ToolCall,
  Usage,
} from "@may/core";

import {
  OpenAIResponsesError,
  OpenAIResponsesProtocolError,
} from "./errors.js";
import {
  OPENAI_RESPONSES_MODEL_STATE_TYPE,
  type OpenAIResponsesUsage,
} from "./protocol.js";
import { readOpenAIResponsesSse } from "./sse.js";

export async function* streamOpenAIResponse(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  let completed: unknown;
  for await (const data of readOpenAIResponsesSse(response, signal)) {
    if (data === "[DONE]") continue;
    const event = parseJson(data, "stream event");
    const type = requireString(event.type, "stream event.type");
    if (type === "response.output_text.delta") {
      const delta = requireString(event.delta, `${type}.delta`);
      if (delta !== "") yield { type: "text.delta", delta };
      continue;
    }
    if (type === "response.refusal.delta") {
      const delta = requireString(event.delta, `${type}.delta`);
      if (delta !== "") yield { type: "text.delta", delta };
      continue;
    }
    if (type === "response.reasoning_summary_text.delta") {
      const delta = requireString(event.delta, `${type}.delta`);
      if (delta !== "") yield { type: "reasoning.delta", delta };
      continue;
    }
    if (type === "response.completed") {
      if (completed !== undefined) {
        throw new OpenAIResponsesProtocolError(
          "OpenAI Responses emitted more than one response.completed event",
        );
      }
      completed = event.response;
      continue;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      throw responseFailure(event.response, type);
    }
    if (type === "error") throw streamError(event);
  }
  if (completed === undefined) {
    throw new OpenAIResponsesProtocolError(
      "OpenAI Responses stream ended without response.completed",
    );
  }
  const parsed = parseCompletedOpenAIResponse(completed);
  yield parsed.usage === undefined
    ? { type: "response.completed", message: parsed.message }
    : { type: "response.completed", message: parsed.message, usage: parsed.usage };
}

export function parseCompletedOpenAIResponse(value: unknown): {
  message: AssistantMessage;
  usage?: Usage;
} {
  const response = requireRecord(value, "response.completed.response");
  const output = requireArray(response.output, "response.output");
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const raw of output) {
    const item = requireRecord(raw, "response.output item");
    const type = requireString(item.type, "response.output item.type");
    if (type === "reasoning") {
      for (const rawSummary of optionalArray(item.summary) ?? []) {
        const summary = requireRecord(rawSummary, "reasoning summary");
        if (summary.type === "summary_text") {
          const text = requireString(summary.text, "reasoning summary.text");
          if (text !== "") content.push({ type: "reasoning", text });
        }
      }
      continue;
    }
    if (type === "message") {
      if (item.role !== "assistant") continue;
      for (const rawPart of requireArray(item.content, "message.content")) {
        const part = requireRecord(rawPart, "message content part");
        if (part.type === "output_text") {
          const text = requireString(part.text, "output_text.text");
          if (text !== "") content.push({ type: "text", text });
        }
        if (part.type === "refusal") {
          const refusal = requireString(part.refusal, "refusal.refusal");
          if (refusal !== "") content.push({ type: "text", text: refusal });
        }
      }
      continue;
    }
    if (type === "function_call") {
      const id = requireString(item.call_id, "function_call.call_id");
      const name = requireString(item.name, "function_call.name");
      const argumentsJson = requireString(
        item.arguments,
        "function_call.arguments",
      );
      toolCalls.push({ id, name, input: parseArguments(argumentsJson, id) });
    }
  }

  const message: AssistantMessage = {
    role: "assistant",
    content,
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    modelState: {
      type: OPENAI_RESPONSES_MODEL_STATE_TYPE,
      data: { items: output },
    },
  };
  const usage = parseUsage(response.usage);
  return usage === undefined ? { message } : { message, usage };
}

export function parseUsage(value: unknown): Usage | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = requireRecord(value, "response.usage") as OpenAIResponsesUsage;
  const inputTokens = optionalTokenCount(usage.input_tokens, "input_tokens");
  const outputTokens = optionalTokenCount(usage.output_tokens, "output_tokens");
  const totalTokens = optionalTokenCount(usage.total_tokens, "total_tokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function parseArguments(value: string, callId: string): unknown {
  try {
    return JSON.parse(value === "" ? "{}" : value);
  } catch (error) {
    throw new OpenAIResponsesProtocolError(
      `OpenAI Responses function call "${callId}" has invalid arguments JSON`,
      { cause: error },
    );
  }
}

function responseFailure(value: unknown, type: string): Error {
  const response = requireRecord(value, type);
  const error = optionalRecord(response.error);
  const details = optionalRecord(response.incomplete_details);
  const message = typeof error?.message === "string"
    ? error.message
    : typeof details?.reason === "string"
    ? details.reason
    : `OpenAI Responses emitted ${type}`;
  return new OpenAIResponsesError(message, {
    ...(typeof error?.code === "string" ? { providerType: error.code } : {}),
  });
}

function streamError(event: Record<string, unknown>): Error {
  const error = optionalRecord(event.error) ?? event;
  return new OpenAIResponsesError(
    typeof error.message === "string" ? error.message : "OpenAI Responses stream error",
    {
      ...(typeof error.code === "string"
        ? { providerType: error.code }
        : typeof error.type === "string"
        ? { providerType: error.type }
        : {}),
      ...(typeof event.request_id === "string" ? { requestId: event.request_id } : {}),
    },
  );
}

function parseJson(value: string, field: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(value), field);
  } catch (error) {
    if (error instanceof OpenAIResponsesProtocolError) throw error;
    throw new OpenAIResponsesProtocolError(
      `OpenAI Responses emitted invalid JSON for ${field}`,
      { cause: error },
    );
  }
}

function optionalTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenAIResponsesProtocolError(`response.usage.${field} is invalid`);
  }
  return value as number;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAIResponsesProtocolError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : requireRecord(value, "value");
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OpenAIResponsesProtocolError(`${field} must be an array`);
  }
  return value;
}

function optionalArray(value: unknown): unknown[] | undefined {
  return value === undefined ? undefined : requireArray(value, "value");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new OpenAIResponsesProtocolError(`${field} must be a string`);
  }
  return value;
}
