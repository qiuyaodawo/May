import type {
  Model,
  ModelEvent,
  ModelRequest,
  ModelStreamOptions,
} from "@may/core";

import {
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
} from "./convert.js";
import {
  OpenAIChatCompletionsApiError,
  OpenAIChatCompletionsFinishReasonError,
  OpenAIChatCompletionsProtocolError,
} from "./errors.js";
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleToolDefinition,
} from "./protocol.js";
import { streamOpenAICompatibleResponse } from "./stream.js";

/** Provider/model metadata determines concrete supported values. */
export type OpenAIChatCompletionsReasoningEffort = string;

export interface OpenAIChatCompletionsModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
  reasoningEffort?: OpenAIChatCompletionsReasoningEffort;
  store?: boolean;
  fetch?: typeof globalThis.fetch;
}

interface OpenAIChatCompletionsRequest {
  model: string;
  messages: OpenAICompatibleMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAICompatibleToolDefinition[];
  max_completion_tokens?: number;
  reasoning_effort?: OpenAIChatCompletionsReasoningEffort;
  store?: boolean;
}

export class OpenAIChatCompletionsModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly maxOutputTokens: number | undefined;
  private readonly reasoningEffort:
    | OpenAIChatCompletionsReasoningEffort
    | undefined;
  private readonly store: boolean | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: OpenAIChatCompletionsModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new TypeError("apiKey must not be empty");
    }
    if (options.model.trim() === "") {
      throw new TypeError("model must not be empty");
    }
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) ||
        options.maxOutputTokens < 1)
    ) {
      throw new RangeError("maxOutputTokens must be a positive safe integer");
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1")
      .replace(/\/+$/, "");
    this.maxOutputTokens = options.maxOutputTokens;
    this.reasoningEffort = options.reasoningEffort;
    this.store = options.store;
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
      providerName: "OpenAI-compatible chat",
      requireDone: true,
      protocolError: (message, errorOptions) =>
        new OpenAIChatCompletionsProtocolError(message, errorOptions),
      finishReasonError: (finishReason) =>
        new OpenAIChatCompletionsFinishReasonError(finishReason),
    });
  }

  private createRequest(request: ModelRequest): OpenAIChatCompletionsRequest {
    const body: OpenAIChatCompletionsRequest = {
      model: this.model,
      messages: toOpenAICompatibleMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools.length > 0) {
      body.tools = toOpenAICompatibleTools(request.tools);
    }
    if (this.maxOutputTokens !== undefined) {
      body.max_completion_tokens = this.maxOutputTokens;
    }
    if (this.reasoningEffort !== undefined) {
      body.reasoning_effort = this.reasoningEffort;
    }
    if (this.store !== undefined) body.store = this.store;
    return body;
  }
}

async function createApiError(
  response: Response,
): Promise<OpenAIChatCompletionsApiError> {
  const text = await response.text();
  let message = text ||
    `OpenAI-compatible chat request failed with status ${response.status}`;
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
    // Keep the response text when the endpoint did not return JSON.
  }

  const options: ConstructorParameters<
    typeof OpenAIChatCompletionsApiError
  >[0] = { status: response.status, message };
  if (providerType !== undefined) options.providerType = providerType;
  if (providerCode !== undefined) options.providerCode = providerCode;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs;
  return new OpenAIChatCompletionsApiError(options);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
}
