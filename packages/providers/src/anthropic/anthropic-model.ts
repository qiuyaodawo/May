import { executeRecordedRequest, requestEndpoint } from "@sortedyuan/may/core";
import type { Message, Model, ModelEvent, ModelRequest, ModelStreamOptions } from "@sortedyuan/may/core";
import { parseRetryAfterMs } from "../openai-compatible/http.js";
import { toAnthropicRequestParts, toAnthropicThinking, toAnthropicTools } from "./convert.js";
import { AnthropicApiError } from "./errors.js";
import type { AnthropicMessagesRequest, AnthropicReasoningEffort, AnthropicThinkingConfig } from "./protocol.js";
import { streamAnthropicResponse } from "./stream.js";
import {
  assertServerToolOrigin,
  serverToolOrigin,
  unfinishedServerMessage,
  validateWebSearch,
  webSearchRequest,
  withServerToolOrigin,
  type WebSearchOptions,
} from "../web-search.js";

/** @experimental */
export interface AnthropicModelOptions {
  webSearch?: false | WebSearchOptions;
  promptCaching?: false | AnthropicPromptCachingOptions;
  apiKey: string;
  model: string;
  baseURL?: string;
  apiVersion?: string;
  maxTokens?: number;
  thinking?: Readonly<AnthropicThinkingConfig>;
  reasoningEffort?: AnthropicReasoningEffort;
  fetch?: typeof globalThis.fetch;
}

/** @experimental */
export interface AnthropicPromptCachingOptions {
  readonly ttl?: "5m" | "1h";
  readonly cacheInstructions?: boolean;
}

const FILES_API_BETA = "files-api-2025-04-14";

/** @experimental */
export class AnthropicModel implements Model {
  readonly supportsRequestRecording = true;
  private readonly apiKey: string;
  private readonly promptCaching: false | AnthropicPromptCachingOptions | undefined;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly apiVersion: string;
  private readonly maxTokens: number;
  private readonly thinking: AnthropicThinkingConfig | undefined;
  private readonly reasoningEffort: AnthropicReasoningEffort | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly webSearch: false | WebSearchOptions | undefined;

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
    if (options.apiVersion !== undefined && options.apiVersion.trim() === "") {
      throw new TypeError("apiVersion must not be empty");
    }
    if (options.thinking?.type === "enabled") {
      if (!Number.isSafeInteger(options.thinking.budgetTokens) || options.thinking.budgetTokens < 1024) {
        throw new RangeError("thinking.budgetTokens must be a safe integer of at least 1024");
      }
      if (options.thinking.budgetTokens >= maxTokens) {
        throw new RangeError("thinking.budgetTokens must be less than maxTokens");
      }
    }

    this.apiKey = options.apiKey;
    this.webSearch = validateWebSearch("anthropic-messages", options.webSearch);
    if (options.promptCaching !== undefined && options.promptCaching !== false) {
      if (
        typeof options.promptCaching !== "object" ||
        options.promptCaching === null ||
        Array.isArray(options.promptCaching)
      ) {
        throw new TypeError("promptCaching must be false or an object");
      }
      if (options.promptCaching.ttl !== undefined && !["5m", "1h"].includes(options.promptCaching.ttl)) {
        throw new TypeError("promptCaching.ttl must be 5m or 1h");
      }
      if (
        options.promptCaching.cacheInstructions !== undefined &&
        typeof options.promptCaching.cacheInstructions !== "boolean"
      ) {
        throw new TypeError("promptCaching.cacheInstructions must be a boolean");
      }
    }
    this.promptCaching =
      options.promptCaching === undefined || options.promptCaching === false
        ? options.promptCaching
        : { ...options.promptCaching };
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? "2023-06-01";
    this.maxTokens = maxTokens;
    this.thinking = cloneThinking(options.thinking);
    this.reasoningEffort = options.reasoningEffort;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    if (request.responseFormat !== undefined) throw new TypeError("Anthropic adapter does not support responseFormat");
    const body = this.createRequest(request);
    yield* executeRecordedRequest(
      {
        version: 1,
        adapter: "anthropic-messages",
        purpose: "generation",
        endpoint: requestEndpoint(`${this.baseURL}/v1/messages`),
        request,
        body,
        protocol: {
          "anthropic-version": this.apiVersion,
          ...(usesFileId(request.messages) ? { "anthropic-beta": FILES_API_BETA } : {}),
        },
      },
      options.recordRequest,
      options.signal,
      (body) => this.execute(body, request, options),
    );
  }

  private async *execute(body: string, request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    const headers: Record<string, string> = {
      "anthropic-version": this.apiVersion,
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    };
    if (usesFileId(request.messages)) {
      headers["anthropic-beta"] = FILES_API_BETA;
    }
    const response = await this.fetchImplementation(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
    });

    if (!response.ok) throw await createApiError(response);
    const origin = serverToolOrigin(
      "anthropic-messages",
      this.model,
      this.baseURL,
      this.webSearch ? webSearchRequest("anthropic-messages", this.webSearch) : undefined,
    );
    for await (const event of streamAnthropicResponse(response, options.signal, request.messages)) {
      if (event.type === "response.completed" && event.message.modelState)
        event.message.modelState = withServerToolOrigin(event.message.modelState, origin);
      yield event;
    }
  }

  private createRequest(request: ModelRequest): AnthropicMessagesRequest {
    const search = this.webSearch ? webSearchRequest("anthropic-messages", this.webSearch) : undefined;
    assertServerToolOrigin(request, serverToolOrigin("anthropic-messages", this.model, this.baseURL, search));
    if (this.webSearch && request.tools.some((tool) => tool.name === "web_search"))
      throw new TypeError("web_search function conflicts with the Anthropic server tool");
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
    if (search) body.tools = [...(body.tools ?? []), search as NonNullable<AnthropicMessagesRequest["tools"]>[number]];
    const pending = unfinishedServerMessage(request.messages);
    if (pending?.modelState?.data) {
      const container = (pending.modelState.data as { container?: { id?: string } | string }).container;
      const id = typeof container === "string" ? container : container?.id;
      if (id !== undefined) body.container = id;
    }
    if (this.promptCaching) {
      const cacheControl = { type: "ephemeral" as const, ttl: this.promptCaching.ttl ?? "5m" };
      body.cache_control = cacheControl;
      if (this.promptCaching.cacheInstructions) {
        if (parts.system !== undefined)
          body.system = [{ type: "text", text: parts.system, cache_control: cacheControl }];
        const lastTool = body.tools?.at(-1);
        if (lastTool) lastTool.cache_control = cacheControl;
      }
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
  return messages.some((message) =>
    message.content.some((part) => (part.type === "image" || part.type === "file") && part.source.type === "file"),
  );
}

function cloneThinking(thinking: Readonly<AnthropicThinkingConfig> | undefined): AnthropicThinkingConfig | undefined {
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
