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
  DeepSeekApiError,
  DeepSeekFinishReasonError,
  DeepSeekProtocolError,
} from "./errors.js";
import type {
  DeepSeekChatRequest,
  DeepSeekChunk,
  DeepSeekToolCallDelta,
} from "./protocol.js";
import { readSseData } from "./sse.js";

export type DeepSeekReasoningEffort = "low" | "high" | "xhigh" | "max";

export interface DeepSeekModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: DeepSeekReasoningEffort;
  fetch?: typeof globalThis.fetch;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class DeepSeekModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly thinking: "enabled" | "disabled" | undefined;
  private readonly reasoningEffort: DeepSeekReasoningEffort | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: DeepSeekModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new TypeError("apiKey must not be empty");
    }
    if (options.model.trim() === "") {
      throw new TypeError("model must not be empty");
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.deepseek.com")
      .replace(/\/+$/, "");
    this.thinking = options.thinking;
    this.reasoningEffort = options.reasoningEffort;
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

        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
          yield { type: "reasoning.delta", delta: delta.reasoning_content };
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
      throw new DeepSeekProtocolError(
        "DeepSeek stream ended without a finish_reason",
      );
    }
    if (finishReason !== "stop" && finishReason !== "tool_calls") {
      throw new DeepSeekFinishReasonError(finishReason);
    }

    const toolCalls = completeToolCalls(pendingCalls);
    if (finishReason === "tool_calls" && toolCalls.length === 0) {
      throw new DeepSeekProtocolError(
        "DeepSeek finished with tool_calls but emitted no tool calls",
      );
    }

    const message: AssistantMessage = { role: "assistant", content: [] };
    if (reasoning !== "") {
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

  private createRequest(request: ModelRequest): DeepSeekChatRequest {
    const body: DeepSeekChatRequest = {
      model: this.model,
      messages: convertMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools.length > 0) body.tools = convertTools(request.tools);
    if (this.thinking !== undefined) {
      body.thinking = { type: this.thinking };
    }
    if (this.reasoningEffort !== undefined) {
      body.reasoning_effort = this.reasoningEffort;
    }

    return body;
  }
}

function parseChunk(data: string): DeepSeekChunk {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) {
      throw new TypeError("chunk is not an object");
    }
    return value as DeepSeekChunk;
  } catch (error) {
    throw new DeepSeekProtocolError("DeepSeek emitted invalid SSE JSON", {
      cause: error,
    });
  }
}

function mergeToolCall(
  calls: Map<number, PendingToolCall>,
  delta: DeepSeekToolCallDelta,
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
        throw new DeepSeekProtocolError(
          `DeepSeek emitted an incomplete tool call at index ${index}`,
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
    // Preserve malformed model output so the Tool's parse hook can reject it
    // and May can return the validation error to the model.
    return input;
  }
}

function convertUsage(usage: NonNullable<DeepSeekChunk["usage"]>): Usage {
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

async function createApiError(response: Response): Promise<DeepSeekApiError> {
  const text = await response.text();
  let message = text || `DeepSeek request failed with status ${response.status}`;
  let providerType: string | undefined;
  let providerCode: string | undefined;

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
    };
    if (typeof parsed.error?.message === "string") {
      message = parsed.error.message;
    }
    if (typeof parsed.error?.type === "string") {
      providerType = parsed.error.type;
    }
    if (typeof parsed.error?.code === "string") {
      providerCode = parsed.error.code;
    }
  } catch {
    // Keep the response text as the error message when it is not JSON.
  }

  const options: ConstructorParameters<typeof DeepSeekApiError>[0] = {
    status: response.status,
    message,
  };
  if (providerType !== undefined) options.providerType = providerType;
  if (providerCode !== undefined) options.providerCode = providerCode;
  return new DeepSeekApiError(options);
}
