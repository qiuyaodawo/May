import {
  assertModelResponseFormat,
  executeRecordedRequest,
  omitUndefined,
  requestEndpoint,
  validateStructuredModelResponse,
  type Model,
  type ModelEvent,
  type ModelRequest,
  type ModelStreamOptions,
} from "@sortedyuan/may/core";
import { toOpenAICompatibleMessages, toOpenAICompatibleTools } from "./convert.js";
import {
  OpenAICompatibleApiError,
  OpenAICompatibleFinishReasonError,
  OpenAICompatibleProtocolError,
} from "./errors.js";
import { parseRetryAfterMs } from "./http.js";
import type { OpenAICompatibleMessage, OpenAICompatibleToolDefinition } from "./protocol.js";
import { streamOpenAICompatibleResponse } from "./stream.js";

export interface OpenAICompatibleChatRequest {
  model: string;
  messages: OpenAICompatibleMessage[];
  stream: true;
  stream_options?: { include_usage: true };
  tools?: OpenAICompatibleToolDefinition[];
  tool_stream?: true;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  store?: boolean;
  response_format?: Readonly<Record<string, unknown>>;
  thinking?: Readonly<Record<string, unknown>>;
}

/** Differences between OpenAI-compatible chat endpoints. */
export interface OpenAICompatibleDialect {
  /** Display name used in error messages. */
  readonly provider: string;
  /** Request recording adapter identifier. */
  readonly adapter: string;
  /** Prefix of error codes, for example `DEEPSEEK` in `DEEPSEEK_API_ERROR`. */
  readonly errorCodePrefix: string;
  readonly defaultBaseURL: string;
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly streamUsage: boolean;
  readonly includeToolName: boolean;
  readonly requireDone: boolean;
  readonly supportsResponseFormat: boolean;
  /** Add provider-specific request fields after the shared fields are set. */
  readonly extendRequest?: (body: OpenAICompatibleChatRequest, request: ModelRequest) => void;
}

export interface OpenAICompatibleChatModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenAICompatibleChatModel implements Model {
  readonly supportsRequestRecording = true;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly maxOutputTokens: number | undefined;
  private readonly reasoningEffort: string | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(
    options: OpenAICompatibleChatModelOptions,
    private readonly dialect: OpenAICompatibleDialect,
  ) {
    if (options.apiKey.trim() === "") throw new TypeError("apiKey must not be empty");
    if (options.model.trim() === "") throw new TypeError("model must not be empty");
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)
    ) {
      throw new RangeError("Maximum output tokens must be a positive safe integer");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? dialect.defaultBaseURL).replace(/\/+$/, "");
    this.maxOutputTokens = options.maxOutputTokens;
    this.reasoningEffort = options.reasoningEffort;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    if (this.dialect.supportsResponseFormat) assertModelResponseFormat(request);
    else if (request.responseFormat !== undefined)
      throw new TypeError(`${this.dialect.provider} adapter does not support responseFormat`);
    yield* executeRecordedRequest(
      {
        version: 1,
        adapter: this.dialect.adapter,
        purpose: "generation",
        endpoint: requestEndpoint(`${this.baseURL}/chat/completions`),
        request,
        body: this.createRequest(request),
      },
      options.recordRequest,
      options.signal,
      (body) => this.execute(body, request, options),
    );
  }

  private async *execute(body: string, request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    const response = await this.fetchImplementation(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body,
      signal: options.signal,
    });
    if (!response.ok) throw await this.createApiError(response);
    const { provider, errorCodePrefix } = this.dialect;
    for await (const event of streamOpenAICompatibleResponse(response, {
      signal: options.signal,
      providerName: provider,
      requireDone: this.dialect.requireDone,
      protocolError: (message, errorOptions) =>
        new OpenAICompatibleProtocolError(provider, errorCodePrefix, message, errorOptions),
      finishReasonError: (finishReason) =>
        new OpenAICompatibleFinishReasonError(provider, errorCodePrefix, finishReason),
    })) {
      if (event.type === "response.completed" && this.dialect.supportsResponseFormat)
        validateStructuredModelResponse(event.message, request, event);
      yield event;
    }
  }

  private createRequest(request: ModelRequest): OpenAICompatibleChatRequest {
    const body: OpenAICompatibleChatRequest = {
      model: this.model,
      messages: toOpenAICompatibleMessages(request.messages, { includeToolName: this.dialect.includeToolName }),
      stream: true,
    };
    if (this.dialect.streamUsage) body.stream_options = { include_usage: true };
    if (request.tools.length > 0) body.tools = toOpenAICompatibleTools(request.tools);
    if (this.maxOutputTokens !== undefined) body[this.dialect.maxTokensField] = this.maxOutputTokens;
    if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;
    if (request.responseFormat !== undefined) {
      const format = request.responseFormat;
      body.response_format =
        format.type === "json"
          ? { type: "json_object" }
          : {
              type: "json_schema",
              json_schema: omitUndefined({ name: format.name, schema: format.schema, strict: format.strict }),
            };
    }
    this.dialect.extendRequest?.(body, request);
    return body;
  }

  private async createApiError(response: Response): Promise<OpenAICompatibleApiError> {
    const text = await response.text();
    let message = text || `${this.dialect.provider} request failed with status ${response.status}`;
    let providerType: string | undefined;
    let providerCode: string | number | undefined;
    let parsed: { error?: { message?: unknown; type?: unknown; code?: unknown } } | undefined;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (error) {
      // Endpoints may return plain text errors; the response text is the message.
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (typeof parsed?.error?.message === "string") message = parsed.error.message;
    if (typeof parsed?.error?.type === "string") providerType = parsed.error.type;
    if (typeof parsed?.error?.code === "string" || typeof parsed?.error?.code === "number")
      providerCode = parsed.error.code;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    return new OpenAICompatibleApiError(
      this.dialect.provider,
      this.dialect.errorCodePrefix,
      omitUndefined({
        status: response.status,
        message,
        providerType,
        providerCode,
        retryAfterMs,
      }),
    );
  }
}
