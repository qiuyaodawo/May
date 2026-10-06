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
import { readSseData } from "./http.js";

export interface OpenAICompatibleStreamOptions {
  signal: AbortSignal;
  providerName: string;
  requireDone?: boolean;
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
  let receivedDone = false;
  const pendingCalls = new Map<number, PendingToolCall>();

  for await (const data of readSseData(
    response,
    options.signal,
    options.protocolError,
    options.providerName,
  )) {
    if (data === "[DONE]") {
      receivedDone = true;
      break;
    }
    const chunk = parseChunk(data, options);
    // 服务端可能在 HTTP 200 的流中报告错误，必须在 [DONE] 与 finish_reason 判定之前处理。
    if (chunk.error !== undefined) {
      throw options.protocolError(
        `${options.providerName} stream reported an error: ${
          describeStreamError(chunk.error)
        }`,
      );
    }

    if (chunk.usage) usage = convertUsage(chunk.usage, options);

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

      if (delta?.refusal) {
        text += delta.refusal;
        yield { type: "text.delta", delta: delta.refusal };
      }

      for (const toolDelta of delta?.tool_calls ?? []) {
        mergeToolCall(pendingCalls, toolDelta);
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
    }
  }

  if (options.requireDone && !receivedDone) {
    throw options.protocolError(
      `${options.providerName} stream ended without [DONE]`,
    );
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

/** 只提取服务端 error 的 message、type、code，不输出整个响应内容。 */
function describeStreamError(error: unknown): string {
  if (typeof error === "string") {
    return error.trim() === "" ? "an empty error string" : error;
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return `a ${typeof error} error value ${String(error)}`;
  }
  if (error === null) return "a null error value";
  if (Array.isArray(error)) return "an array error value";
  if (typeof error !== "object") return `an unsupported ${typeof error} error value`;

  const payload = error as { message?: unknown; type?: unknown; code?: unknown };
  const details: string[] = [];
  const message = readText(payload.message);
  const type = readText(payload.type);
  const code = readText(payload.code) ?? readNumber(payload.code);
  if (message !== undefined) details.push(message);
  if (type !== undefined) details.push(`type: ${type}`);
  if (code !== undefined) details.push(`code: ${code}`);
  if (details.length === 0) return "an error object without message, type, or code";
  return details.join(" ");
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

function readNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return String(value);
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
        input: parseToolInput(call.arguments, options),
      };
    });
}

function parseToolInput(input: string, options: OpenAICompatibleStreamOptions): unknown {
  if (input === "") return {};
  try {
    return JSON.parse(input);
  } catch {
    throw options.protocolError(`${options.providerName} emitted invalid tool argument JSON`);
  }
}

function convertUsage(
  usage: NonNullable<OpenAICompatibleChunk["usage"]>,
  options: OpenAICompatibleStreamOptions,
): Usage {
  const converted: Usage = {};
  const token = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw options.protocolError(`${options.providerName} usage.${field} must be a non-negative safe integer`);
    return value as number;
  };
  if (usage.prompt_tokens !== undefined) {
    converted.inputTokens = token(usage.prompt_tokens, "prompt_tokens")!;
  }
  if (usage.completion_tokens !== undefined) {
    converted.outputTokens = token(usage.completion_tokens, "completion_tokens")!;
  }
  if (usage.total_tokens !== undefined) {
    converted.totalTokens = token(usage.total_tokens, "total_tokens")!;
  }
  const cachedReadTokens = token(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens, "cached_tokens");
  const cachedWriteTokens = token(usage.prompt_tokens_details?.cache_write_tokens, "cache_write_tokens");
  const reasoningTokens = token(usage.completion_tokens_details?.reasoning_tokens, "reasoning_tokens");
  if (cachedReadTokens !== undefined) converted.cachedReadTokens = cachedReadTokens;
  if (cachedWriteTokens !== undefined) converted.cachedWriteTokens = cachedWriteTokens;
  if (reasoningTokens !== undefined) converted.reasoningTokens = reasoningTokens;
  if (cachedReadTokens !== undefined || cachedWriteTokens !== undefined || reasoningTokens !== undefined) converted.tokenRelations = {
    ...(cachedReadTokens === undefined ? {} : { cachedRead: "input" }),
    ...(cachedWriteTokens === undefined ? {} : { cachedWrite: "input" }),
    ...(reasoningTokens === undefined ? {} : { reasoning: "output" }),
  };
  const items: NonNullable<Usage["items"]>[number][] = [];
  const cachedMiss = token(usage.prompt_cache_miss_tokens, "prompt_cache_miss_tokens");
  if (cachedMiss !== undefined && cachedReadTokens !== undefined && converted.inputTokens !== undefined && cachedReadTokens + cachedMiss !== converted.inputTokens) throw options.protocolError(`${options.providerName} cache token counts do not match prompt_tokens`);
  for (const [id, value] of [["input-audio", usage.prompt_tokens_details?.audio_tokens], ["output-audio", usage.completion_tokens_details?.audio_tokens]] as const) {
    const quantity = token(value, id);
    if (quantity !== undefined && quantity > 0) items.push({ id, quantity, unit: "tokens", includedIn: id === "input-audio" ? "input" : "output" });
  }
  if (items.length > 0) converted.items = items;
  if (converted.inputTokens === undefined || converted.outputTokens === undefined) converted.completeness = { status: "partial", reason: "provider-token-components-missing" };
  return converted;
}
