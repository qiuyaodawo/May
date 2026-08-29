import type {
  Model,
  ModelEvent,
  ModelRequest,
  ModelStreamOptions,
} from "@may/core";
import {
  streamOpenAICompatibleResponse,
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
} from "@may/provider-openai-compatible";
import {
  DeepSeekApiError,
  DeepSeekFinishReasonError,
  DeepSeekProtocolError,
} from "./errors.js";
import type { DeepSeekChatRequest } from "./protocol.js";

export type DeepSeekReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface DeepSeekModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: DeepSeekReasoningEffort;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

export class DeepSeekModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly thinking: "enabled" | "disabled" | undefined;
  private readonly reasoningEffort: DeepSeekReasoningEffort | undefined;
  private readonly maxTokens: number | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: DeepSeekModelOptions) {
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
    this.baseURL = (options.baseURL ?? "https://api.deepseek.com")
      .replace(/\/+$/, "");
    this.thinking = options.thinking;
    this.reasoningEffort = options.reasoningEffort;
    this.maxTokens = options.maxTokens;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
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

    yield* streamOpenAICompatibleResponse(response, {
      signal: options.signal,
      providerName: "DeepSeek",
      protocolError: (message, errorOptions) =>
        new DeepSeekProtocolError(message, errorOptions),
      finishReasonError: (finishReason) =>
        new DeepSeekFinishReasonError(finishReason),
    });
  }

  private createRequest(request: ModelRequest): DeepSeekChatRequest {
    const body: DeepSeekChatRequest = {
      model: this.model,
      messages: toOpenAICompatibleMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools.length > 0) {
      body.tools = toOpenAICompatibleTools(request.tools);
    }
    if (this.thinking !== undefined) {
      body.thinking = { type: this.thinking };
    }
    if (this.reasoningEffort !== undefined) {
      body.reasoning_effort = this.reasoningEffort;
    }
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;

    return body;
  }
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

  const errorOptions: ConstructorParameters<typeof DeepSeekApiError>[0] = {
    status: response.status,
    message,
  };
  if (providerType !== undefined) errorOptions.providerType = providerType;
  if (providerCode !== undefined) errorOptions.providerCode = providerCode;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) errorOptions.retryAfterMs = retryAfterMs;
  return new DeepSeekApiError(errorOptions);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
