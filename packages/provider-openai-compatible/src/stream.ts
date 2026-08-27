import type {
  AssistantMessage,
  ModelEvent,
  ToolCall,
  Usage,
} from "@may/core";
import type {
  OpenAICompatibleChunk,
  OpenAICompatibleToolCallDelta,
} from "./protocol.js";
import { readSseData } from "./sse.js";

export interface OpenAICompatibleStreamOptions {
  signal: AbortSignal;
  providerName: string;
  protocolError(message: string, options?: ErrorOptions): Error;
  finishReasonError(finishReason: string): Error;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function* streamOpenAICompatibleResponse(
  response: Response,
  options: OpenAICompatibleStreamOptions,
): AsyncIterable<ModelEvent> {
  let text = "";
  let reasoning = "";
  let hasReasoningContent = false;
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  const pendingCalls = new Map<number, PendingToolCall>();

  for await (const data of readSseData(
    response,
    options.signal,
    options.protocolError,
    options.providerName,
  )) {
    if (data === "[DONE]") break;
    const chunk = parseChunk(data, options);

    if (chunk.usage) usage = convertUsage(chunk.usage);

    for (const choice of chunk.choices ?? []) {
      if (choice.index !== 0) continue;
      const delta = choice.delta;

      if (typeof delta?.reasoning_content === "string") {
        hasReasoningContent = true;
        if (delta.reasoning_content !== "") {
          reasoning += delta.reasoning_content;
          yield { type: "reasoning.delta", delta: delta.reasoning_content };
        }
      }

      if (delta?.content) {
        text += delta.content;
        yield { type: "text.delta", delta: delta.content };
      }

      for (const toolDelta of delta?.tool_calls ?? []) {
        mergeToolCall(pendingCalls, toolDelta);
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
    }
  }

  if (finishReason === undefined) {
    throw options.protocolError(
      `${options.providerName} stream ended without a finish_reason`,
    );
  }
  if (finishReason !== "stop" && finishReason !== "tool_calls") {
    throw options.finishReasonError(finishReason);
  }

  const toolCalls = completeToolCalls(pendingCalls, options);
  if (finishReason === "tool_calls" && toolCalls.length === 0) {
    throw options.protocolError(
      `${options.providerName} finished with tool_calls but emitted no tool calls`,
    );
  }

  const message: AssistantMessage = { role: "assistant", content: [] };
  if (hasReasoningContent) {
    message.content.push({ type: "reasoning", text: reasoning });
  }
  if (text !== "") message.content.push({ type: "text", text });
  if (toolCalls.length > 0) message.toolCalls = toolCalls;

  const completed: Extract<ModelEvent, { type: "response.completed" }> = {
    type: "response.completed",
    message,
  };
  if (usage !== undefined) completed.usage = usage;
  yield completed;
}

function parseChunk(
  data: string,
  options: OpenAICompatibleStreamOptions,
): OpenAICompatibleChunk {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) {
      throw new TypeError("chunk is not an object");
    }
    return value as OpenAICompatibleChunk;
  } catch (error) {
    throw options.protocolError(
      `${options.providerName} emitted invalid SSE JSON`,
      { cause: error },
    );
  }
}

function mergeToolCall(
  calls: Map<number, PendingToolCall>,
  delta: OpenAICompatibleToolCallDelta,
): void {
  const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
  if (delta.id !== undefined) call.id = delta.id;
  if (delta.function?.name !== undefined) call.name += delta.function.name;
  if (delta.function?.arguments !== undefined) {
    call.arguments += delta.function.arguments;
  }
  calls.set(delta.index, call);
}

function completeToolCalls(
  calls: Map<number, PendingToolCall>,
  options: OpenAICompatibleStreamOptions,
): ToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => {
      if (call.id === "" || call.name === "") {
        throw options.protocolError(
          `${options.providerName} emitted an incomplete tool call at index ${index}`,
        );
      }

      return {
        id: call.id,
        name: call.name,
        input: parseToolInput(call.arguments),
      };
    });
}

function parseToolInput(input: string): unknown {
  if (input === "") return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function convertUsage(
  usage: NonNullable<OpenAICompatibleChunk["usage"]>,
): Usage {
  const converted: Usage = {};
  if (usage.prompt_tokens !== undefined) {
    converted.inputTokens = usage.prompt_tokens;
  }
  if (usage.completion_tokens !== undefined) {
    converted.outputTokens = usage.completion_tokens;
  }
  if (usage.total_tokens !== undefined) {
    converted.totalTokens = usage.total_tokens;
  }
  return converted;
}
