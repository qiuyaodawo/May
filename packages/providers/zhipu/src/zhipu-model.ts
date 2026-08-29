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
  ZhipuApiError,
  ZhipuFinishReasonError,
  ZhipuProtocolError,
} from "./errors.js";
import type { ZhipuChatRequest } from "./protocol.js";

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
      providerName: "Zhipu",
      protocolError: (message, errorOptions) =>
        new ZhipuProtocolError(message, errorOptions),
      finishReasonError: (finishReason) =>
        new ZhipuFinishReasonError(finishReason),
    });
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
      messages: toOpenAICompatibleMessages(request.messages),
      stream: true,
      thinking,
    };

    if (request.tools.length > 0) {
      body.tools = toOpenAICompatibleTools(request.tools);
      body.tool_stream = true;
    }
    if (this.reasoningEffort !== undefined) {
      body.reasoning_effort = this.reasoningEffort;
    }
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;

    return body;
  }
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

  const errorOptions: ConstructorParameters<typeof ZhipuApiError>[0] = {
    status: response.status,
    message,
  };
  if (providerCode !== undefined) errorOptions.providerCode = providerCode;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) errorOptions.retryAfterMs = retryAfterMs;
  return new ZhipuApiError(errorOptions);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
