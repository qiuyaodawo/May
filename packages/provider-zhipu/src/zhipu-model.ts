import type {
  AssistantMessage,
  Model,
  ModelEvent,
  ModelRequest,
  ToolCall,
  Usage,
} from "@may/core";
import { convertMessages, convertTools } from "./convert.js";
import {
  ZhipuApiError,
  ZhipuFinishReasonError,
  ZhipuProtocolError,
} from "./errors.js";
import type {
  ZhipuChatRequest,
  ZhipuChunk,
  ZhipuToolCallDelta,
} from "./protocol.js";
import { readSseData } from "./sse.js";

export type ZhipuReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ZhipuModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  clearThinking?: boolean;
  reasoningEffort?: ZhipuReasoningEffort;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ZhipuModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly thinking: "enabled" | "disabled";
  private readonly clearThinking: boolean;
  private readonly reasoningEffort: ZhipuReasoningEffort | undefined;
  private readonly maxTokens: number | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: ZhipuModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new TypeError("apiKey must not be empty");
    }
    if (options.model.trim() === "") {
      throw new TypeError("model must not be empty");
    }
    if (
      options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)
    ) {
      throw new RangeError("maxTokens must be a positive safe integer");
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://open.bigmodel.cn/api/paas/v4")
      .replace(/\/+$/, "");
    this.thinking = options.thinking ?? "enabled";
    this.clearThinking = options.clearThinking ?? false;
    this.reasoningEffort = options.reasoningEffort;
    this.maxTokens = options.maxTokens;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent> {
    const response = await this.fetchImplementation(
      `${this.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.createRequest(request)),
        signal: options.signal,
      },
    );

    if (!response.ok) throw await createApiError(response);

    let text = "";
    let reasoning = "";
    let hasReasoningContent = false;
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const pendingCalls = new Map<number, PendingToolCall>();

    for await (const data of readSseData(response, options.signal)) {
      if (data === "[DONE]") break;
      const chunk = parseChunk(data);

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
      throw new ZhipuProtocolError(
        "Zhipu stream ended without a finish_reason",
      );
    }
    if (finishReason !== "stop" && finishReason !== "tool_calls") {
      throw new ZhipuFinishReasonError(finishReason);
    }

    const toolCalls = completeToolCalls(pendingCalls);
    if (finishReason === "tool_calls" && toolCalls.length === 0) {
      throw new ZhipuProtocolError(
        "Zhipu finished with tool_calls but emitted no tool calls",
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

  private createRequest(request: ModelRequest): ZhipuChatRequest {
    const thinking: ZhipuChatRequest["thinking"] = {
      type: this.thinking,
    };
    if (this.thinking === "enabled") {
      thinking.clear_thinking = this.clearThinking;
    }

    const body: ZhipuChatRequest = {
      model: this.model,
      messages: convertMessages(request.messages),
      stream: true,
      thinking,
    };

    if (request.tools.length > 0) {
      body.tools = convertTools(request.tools);
      body.tool_stream = true;
    }
    if (this.reasoningEffort !== undefined) {
      body.reasoning_effort = this.reasoningEffort;
    }
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;

    return body;
  }
}

function parseChunk(data: string): ZhipuChunk {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) {
      throw new TypeError("chunk is not an object");
    }
    return value as ZhipuChunk;
  } catch (error) {
    throw new ZhipuProtocolError("Zhipu emitted invalid SSE JSON", {
      cause: error,
    });
  }
}

function mergeToolCall(
  calls: Map<number, PendingToolCall>,
  delta: ZhipuToolCallDelta,
): void {
  const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
  if (delta.id !== undefined) call.id = delta.id;
  if (delta.function?.name !== undefined) call.name += delta.function.name;
  if (delta.function?.arguments !== undefined) {
    call.arguments += delta.function.arguments;
  }
  calls.set(delta.index, call);
}

function completeToolCalls(calls: Map<number, PendingToolCall>): ToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => {
      if (call.id === "" || call.name === "") {
        throw new ZhipuProtocolError(
          `Zhipu emitted an incomplete tool call at index ${index}`,
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

function convertUsage(usage: NonNullable<ZhipuChunk["usage"]>): Usage {
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

async function createApiError(response: Response): Promise<ZhipuApiError> {
  const text = await response.text();
  let message = text || `Zhipu request failed with status ${response.status}`;
  let providerCode: string | number | undefined;

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      msg?: unknown;
      code?: unknown;
    };
    const parsedMessage = parsed.error?.message ?? parsed.message ?? parsed.msg;
    const parsedCode = parsed.error?.code ?? parsed.code;

    if (typeof parsedMessage === "string") message = parsedMessage;
    if (typeof parsedCode === "string" || typeof parsedCode === "number") {
      providerCode = parsedCode;
    }
  } catch {
    // Keep the response text as the error message when it is not JSON.
  }

  const options: ConstructorParameters<typeof ZhipuApiError>[0] = {
    status: response.status,
    message,
  };
  if (providerCode !== undefined) options.providerCode = providerCode;
  return new ZhipuApiError(options);
}
