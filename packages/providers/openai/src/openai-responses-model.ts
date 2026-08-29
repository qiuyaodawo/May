import type {
  ContextSnapshot,
  Model,
  ModelContextCompactor,
  ModelEvent,
  ModelRequest,
} from "@may/core";

import {
  toOpenAIResponsesRequestParts,
  toOpenAIResponsesTools,
} from "./convert.js";
import {
  OpenAIResponsesError,
  OpenAIResponsesProtocolError,
} from "./errors.js";
import {
  OPENAI_RESPONSES_MODEL_STATE_TYPE,
  type OpenAIReasoningEffort,
  type OpenAIReasoningSummary,
} from "./protocol.js";
import { parseUsage, streamOpenAIResponse } from "./stream.js";

export interface OpenAIResponsesModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  readonly reasoningSummary?: OpenAIReasoningSummary;
  readonly serverCompactThreshold?: number;
  readonly store?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export class OpenAIResponsesModel implements Model {
  readonly contextCompactor: ModelContextCompactor;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly maxOutputTokens: number | undefined;
  private readonly reasoningEffort: OpenAIReasoningEffort | undefined;
  private readonly reasoningSummary: OpenAIReasoningSummary | undefined;
  private readonly serverCompactThreshold: number | undefined;
  private readonly store: boolean;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: OpenAIResponsesModelOptions) {
    if (options.apiKey.trim() === "") throw new TypeError("apiKey must not be empty");
    if (options.model.trim() === "") throw new TypeError("model must not be empty");
    validateOptionalPositiveInteger(options.maxOutputTokens, "maxOutputTokens");
    validateOptionalPositiveInteger(
      options.serverCompactThreshold,
      "serverCompactThreshold",
    );
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
    this.maxOutputTokens = options.maxOutputTokens;
    this.reasoningEffort = options.reasoningEffort;
    this.reasoningSummary = options.reasoningSummary;
    this.serverCompactThreshold = options.serverCompactThreshold;
    this.store = options.store ?? false;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.contextCompactor = {
      name: "openai-responses-compact",
      compact: (snapshot, compactOptions) =>
        this.compact(snapshot, compactOptions.signal),
    };
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent> {
    const parts = toOpenAIResponsesRequestParts(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      input: parts.input,
      stream: true,
      store: this.store,
      include: ["reasoning.encrypted_content"],
    };
    if (parts.instructions !== undefined) body.instructions = parts.instructions;
    if (request.tools.length > 0) body.tools = toOpenAIResponsesTools(request.tools);
    if (this.maxOutputTokens !== undefined) {
      body.max_output_tokens = this.maxOutputTokens;
    }
    const reasoning = this.reasoningConfig();
    if (reasoning !== undefined) body.reasoning = reasoning;
    if (this.serverCompactThreshold !== undefined) {
      body.context_management = [{
        type: "compaction",
        compact_threshold: this.serverCompactThreshold,
      }];
    }

    const response = await this.fetch("/responses", body, options.signal);
    yield* streamOpenAIResponse(response, options.signal);
  }

  private async compact(
    snapshot: Readonly<ContextSnapshot>,
    signal: AbortSignal | undefined,
  ) {
    const effectiveSignal = signal ?? new AbortController().signal;
    const parts = toOpenAIResponsesRequestParts(
      snapshot.messages,
      snapshot.instructions,
    );
    const body: Record<string, unknown> = {
      model: this.model,
      input: parts.input,
    };
    if (parts.instructions !== undefined) body.instructions = parts.instructions;
    const response = await this.fetch("/responses/compact", body, effectiveSignal);
    const value = await response.json().catch((error) => {
      throw new OpenAIResponsesProtocolError(
        "OpenAI Responses compact returned invalid JSON",
        { cause: error },
      );
    });
    const compacted = requireRecord(value, "compacted response");
    if (compacted.object !== "response.compaction") {
      throw new OpenAIResponsesProtocolError(
        "OpenAI Responses compact returned an unexpected object",
      );
    }
    if (!Array.isArray(compacted.output)) {
      throw new OpenAIResponsesProtocolError(
        "OpenAI Responses compact output must be an array",
      );
    }
    if (!compacted.output.some((item) =>
      typeof item === "object" && item !== null &&
      "type" in item && item.type === "compaction"
    )) {
      throw new OpenAIResponsesProtocolError(
        "OpenAI Responses compact output has no compaction item",
      );
    }
    const usage = parseUsage(compacted.usage);
    return {
      messages: [{
        role: "assistant" as const,
        content: [],
        modelState: {
          type: OPENAI_RESPONSES_MODEL_STATE_TYPE,
          data: { items: compacted.output },
        },
      }],
      ...(usage?.outputTokens === undefined
        ? {}
        : { effectiveTokens: usage.outputTokens }),
    };
  }

  private reasoningConfig(): Record<string, unknown> | undefined {
    if (this.reasoningEffort === undefined && this.reasoningSummary === undefined) {
      return undefined;
    }
    return {
      ...(this.reasoningEffort === undefined
        ? {}
        : { effort: this.reasoningEffort }),
      ...(this.reasoningSummary === undefined
        ? {}
        : { generate_summary: this.reasoningSummary }),
    };
  }

  private async fetch(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchImplementation(`${this.baseURL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await createApiError(response);
    return response;
  }
}

async function createApiError(response: Response): Promise<OpenAIResponsesError> {
  const text = await response.text();
  let message = text || `OpenAI request failed with status ${response.status}`;
  let providerType: string | undefined;
  let requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = requireRecord(JSON.parse(text), "error response");
    const error = requireRecord(body.error, "error response.error");
    if (typeof error.message === "string") message = error.message;
    if (typeof error.type === "string") providerType = error.type;
    if (typeof error.code === "string") providerType = error.code;
    if (typeof body.request_id === "string") requestId = body.request_id;
  } catch {
    // Preserve the HTTP response text when the body is not structured JSON.
  }
  return new OpenAIResponsesError(message, {
    status: response.status,
    ...(providerType === undefined ? {} : { providerType }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAIResponsesProtocolError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
