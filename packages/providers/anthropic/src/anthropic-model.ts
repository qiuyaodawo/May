import type {
  Message,
  Model,
  ModelEvent,
  ModelRequest,
  ModelStreamOptions,
} from "@may/core";
import {
  toAnthropicRequestParts,
  toAnthropicThinking,
  toAnthropicTools,
} from "./convert.js";
import { AnthropicApiError } from "./errors.js";
import type {
  AnthropicMessagesRequest,
  AnthropicReasoningEffort,
  AnthropicThinkingConfig,
} from "./protocol.js";
import { streamAnthropicResponse } from "./stream.js";

export interface AnthropicModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  apiVersion?: string;
  maxTokens?: number;
  thinking?: Readonly<AnthropicThinkingConfig>;
  reasoningEffort?: AnthropicReasoningEffort;
  fetch?: typeof globalThis.fetch;
}

const FILES_API_BETA = "files-api-2025-04-14";

export class AnthropicModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly apiVersion: string;
  private readonly maxTokens: number;
  private readonly thinking: AnthropicThinkingConfig | undefined;
  private readonly reasoningEffort: AnthropicReasoningEffort | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: AnthropicModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new TypeError("apiKey must not be empty");
    }
    if (options.model.trim() === "") {
      throw new TypeError("model must not be empty");
    }

    const maxTokens = options.maxTokens ?? 4096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new RangeError("maxTokens must be a positive safe integer");
    }
    if (
      options.apiVersion !== undefined &&
      options.apiVersion.trim() === ""
    ) {
      throw new TypeError("apiVersion must not be empty");
    }
    if (options.thinking?.type === "enabled") {
      if (
        !Number.isSafeInteger(options.thinking.budgetTokens) ||
        options.thinking.budgetTokens < 1024
      ) {
        throw new RangeError(
          "thinking.budgetTokens must be a safe integer of at least 1024",
        );
      }
      if (options.thinking.budgetTokens >= maxTokens) {
        throw new RangeError(
          "thinking.budgetTokens must be less than maxTokens",
        );
      }
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com")
      .replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? "2023-06-01";
    this.maxTokens = maxTokens;
    this.thinking = cloneThinking(options.thinking);
    this.reasoningEffort = options.reasoningEffort;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    const body = this.createRequest(request);
    const headers: Record<string, string> = {
      "anthropic-version": this.apiVersion,
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    };
    if (usesFileId(request.messages)) {
      headers["anthropic-beta"] = FILES_API_BETA;
    }
    const response = await this.fetchImplementation(
      `${this.baseURL}/v1/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );

    if (!response.ok) throw await createApiError(response);
    yield* streamAnthropicResponse(response, options.signal);
  }

  private createRequest(request: ModelRequest): AnthropicMessagesRequest {
    const parts = toAnthropicRequestParts(request.messages);
    const body: AnthropicMessagesRequest = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: parts.messages,
      stream: true,
    };

    if (parts.system !== undefined) body.system = parts.system;
    if (request.tools.length > 0) {
      body.tools = toAnthropicTools(request.tools);
    }
    if (this.thinking !== undefined) {
      body.thinking = toAnthropicThinking(this.thinking);
    }
    if (this.reasoningEffort !== undefined) {
      body.output_config = { effort: this.reasoningEffort };
    }
    return body;
  }
}

function usesFileId(messages: readonly Message[]): boolean {
  return messages.some((message) => message.content.some((part) =>
    (part.type === "image" || part.type === "file") &&
    part.source.type === "file"
  ));
}

function cloneThinking(
  thinking: Readonly<AnthropicThinkingConfig> | undefined,
): AnthropicThinkingConfig | undefined {
  return thinking === undefined ? undefined : { ...thinking };
}

async function createApiError(response: Response): Promise<AnthropicApiError> {
  const text = await response.text();
  let message = text || `Anthropic request failed with status ${response.status}`;
  let providerType: string | undefined;
  let requestId = response.headers.get("request-id") ?? undefined;

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; type?: unknown };
      request_id?: unknown;
    };
    if (typeof parsed.error?.message === "string") {
      message = parsed.error.message;
    }
    if (typeof parsed.error?.type === "string") {
      providerType = parsed.error.type;
    }
    if (typeof parsed.request_id === "string") {
      requestId = parsed.request_id;
    }
  } catch {
    // Keep the response text as the error message when it is not JSON.
  }

  const options: ConstructorParameters<typeof AnthropicApiError>[0] = {
    status: response.status,
    message,
  };
  if (providerType !== undefined) options.providerType = providerType;
  if (requestId !== undefined) options.requestId = requestId;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs;
  return new AnthropicApiError(options);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
