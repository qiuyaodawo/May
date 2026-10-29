import { randomUUID } from "node:crypto";
import { assertModelResponseFormat, validateStructuredModelResponse, type AssistantMessage, type Model, type ModelEvent, type ModelRequest, type ModelStreamOptions, type ToolCall } from "@sortedyuan/may/core";
import { parseRetryAfterMs, readSseData } from "../openai-compatible/http.js";
import { convertGeminiUsage, isRecord, toGeminiRequestParts } from "./convert.js";
import { GeminiApiError, GeminiFinishReasonError, GeminiProtocolError } from "./errors.js";
import { GEMINI_MODEL_STATE_TYPE, type GeminiGenerateContentRequest, type GeminiPart, type GeminiUsageMetadata } from "./protocol.js";

export interface GeminiModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  fetch?: typeof globalThis.fetch;
}

export class GeminiModel implements Model {
  private readonly baseURL: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly options: GeminiModelOptions;

  constructor(options: GeminiModelOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") throw new TypeError("apiKey must not be empty");
    if (typeof options.model !== "string" || options.model.trim() === "") throw new TypeError("model must not be empty");
    if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) throw new RangeError("maxOutputTokens must be a positive safe integer");
    if (options.thinkingBudget !== undefined && (!Number.isSafeInteger(options.thinkingBudget) || options.thinkingBudget < -1)) throw new RangeError("thinkingBudget must be an integer greater than or equal to -1");
    if (options.reasoningEffort !== undefined && (typeof options.reasoningEffort !== "string" || options.reasoningEffort.trim() === "")) throw new TypeError("reasoningEffort must not be empty");
    if (options.reasoningEffort !== undefined && options.thinkingBudget !== undefined) throw new TypeError("reasoningEffort and thinkingBudget are mutually exclusive");
    if (options.includeThoughts !== undefined && typeof options.includeThoughts !== "boolean") throw new TypeError("includeThoughts must be a boolean");
    this.options = { ...options };
    this.baseURL = (options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "");
    const url = new URL(this.baseURL);
    if (!["https:", "http:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new TypeError("baseURL must be an HTTP URL without credentials, query, or fragment");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    assertModelResponseFormat(request);
    const body: GeminiGenerateContentRequest = toGeminiRequestParts(request.messages);
    if (body.contents.length === 0) throw new GeminiProtocolError("Gemini requires non-empty contents");
    if (request.tools.length > 0) body.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }];
    const config: NonNullable<GeminiGenerateContentRequest["generationConfig"]> = {};
    if (this.options.maxOutputTokens !== undefined) config.maxOutputTokens = this.options.maxOutputTokens;
    if (this.options.reasoningEffort !== undefined || this.options.thinkingBudget !== undefined || this.options.includeThoughts !== undefined) {
      config.thinkingConfig = {
        ...(this.options.reasoningEffort === undefined ? {} : { thinkingLevel: this.options.reasoningEffort }),
        ...(this.options.thinkingBudget === undefined ? {} : { thinkingBudget: this.options.thinkingBudget }),
        ...(this.options.includeThoughts === undefined ? {} : { includeThoughts: this.options.includeThoughts }),
      };
    }
    if (request.responseFormat !== undefined) {
      config.responseMimeType = "application/json";
      if (request.responseFormat.type === "jsonSchema") config.responseJsonSchema = request.responseFormat.schema;
    }
    if (Object.keys(config).length > 0) body.generationConfig = config;
    const model = this.options.model.replace(/^models\//u, "");
    const response = await this.fetchImplementation(`${this.baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": this.options.apiKey, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) throw new GeminiApiError(response.status, await response.text(), parseRetryAfterMs(response.headers.get("retry-after")));

    const message: AssistantMessage = { role: "assistant", content: [] };
    const parts: GeminiPart[] = [];
    const toolCalls: ToolCall[] = [];
    let metadata: GeminiUsageMetadata | undefined;
    let finishReason: string | undefined;
    for await (const data of readSseData(response, options.signal, (message, cause) => new GeminiProtocolError(message, cause), "Google Gemini")) {
      if (data === "[DONE]") break;
      const chunk: unknown = JSON.parse(data);
      if (!isRecord(chunk)) throw new GeminiProtocolError("Gemini stream chunk must be an object");
      if (chunk.error !== undefined) throw new GeminiProtocolError(`Gemini stream error: ${describeError(chunk.error)}`);
      if (isRecord(chunk.promptFeedback) && chunk.promptFeedback.blockReason !== undefined) throw new GeminiFinishReasonError(String(chunk.promptFeedback.blockReason));
      if (chunk.usageMetadata !== undefined) {
        if (!isRecord(chunk.usageMetadata)) throw new GeminiProtocolError("Gemini usageMetadata must be an object");
        metadata = { ...metadata, ...chunk.usageMetadata };
        convertGeminiUsage(metadata);
      }
      if (chunk.candidates === undefined) continue;
      if (!Array.isArray(chunk.candidates)) throw new GeminiProtocolError("Gemini candidates must be an array");
      for (const candidate of chunk.candidates) {
        if (!isRecord(candidate)) throw new GeminiProtocolError("Gemini candidate must be an object");
        if (candidate.index !== undefined && candidate.index !== 0) continue;
        if (candidate.finishReason !== undefined) {
          if (typeof candidate.finishReason !== "string") throw new GeminiProtocolError("Gemini finishReason must be a string");
          if (finishReason !== undefined && finishReason !== candidate.finishReason) throw new GeminiProtocolError("Gemini emitted conflicting finish reasons");
          finishReason = candidate.finishReason;
        }
        if (candidate.content === undefined) continue;
        if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) throw new GeminiProtocolError("Gemini content.parts must be an array");
        for (const rawPart of candidate.content.parts) {
          if (!isRecord(rawPart)) throw new GeminiProtocolError("Gemini part must be an object");
          if (rawPart.thoughtSignature !== undefined && typeof rawPart.thoughtSignature !== "string") throw new GeminiProtocolError("Gemini thoughtSignature must be a string");
          if (rawPart.thought !== undefined && typeof rawPart.thought !== "boolean") throw new GeminiProtocolError("Gemini thought must be a boolean");
          const part = rawPart as GeminiPart;
          parts.push(structuredClone(part));
          if (part.text !== undefined) {
            if (typeof part.text !== "string") throw new GeminiProtocolError("Gemini text must be a string");
            const type = part.thought ? "reasoning" : "text";
            message.content.push({ type, text: part.text });
            if (part.text !== "") yield { type: part.thought ? "reasoning.delta" : "text.delta", delta: part.text };
          } else if (part.functionCall !== undefined) {
            const call = part.functionCall;
            if (!isRecord(call) || typeof call.name !== "string" || call.name.trim() === "" || (call.args !== undefined && !isRecord(call.args)) || (call.id !== undefined && (typeof call.id !== "string" || call.id === ""))) throw new GeminiProtocolError("Malformed Gemini functionCall");
            const id = call.id ?? randomUUID();
            if (toolCalls.some((existing) => existing.id === id)) throw new GeminiProtocolError("Gemini emitted duplicate function call IDs");
            toolCalls.push({ id, name: call.name, input: call.args ?? {} });
          } else if (part.inlineData !== undefined) {
            const media = part.inlineData;
            if (!isRecord(media) || typeof media.mimeType !== "string" || typeof media.data !== "string") throw new GeminiProtocolError("Malformed Gemini inlineData");
            const type = media.mimeType.startsWith("image/") ? "image" : media.mimeType.startsWith("audio/") ? "audio" : "file";
            message.content.push({ type, source: { type: "base64", mediaType: media.mimeType, data: media.data } });
          } else if (part.thoughtSignature === undefined) {
            throw new GeminiProtocolError("Unsupported Gemini response part");
          }
        }
      }
    }
    options.signal.throwIfAborted();
    if (finishReason === undefined) throw new GeminiProtocolError("Gemini stream ended without finishReason");
    if (finishReason !== "STOP") throw new GeminiFinishReasonError(finishReason);
    if (parts.length === 0) throw new GeminiProtocolError("Gemini completed without content");
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    message.modelState = { type: GEMINI_MODEL_STATE_TYPE, data: { parts, toolCallIds: toolCalls.map((call) => call.id) } };
    const event: Extract<ModelEvent, { type: "response.completed" }> = { type: "response.completed", message, ...(metadata === undefined ? {} : { usage: convertGeminiUsage(metadata) }) };
    validateStructuredModelResponse(message, request, event);
    yield event;
  }
}

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return "The server returned an error without a message";
}
