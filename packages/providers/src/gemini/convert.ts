import type { ContentPart, Message, Usage } from "@sortedyuan/may/core";
import { UnsupportedContentError } from "@sortedyuan/may/core";
import { GeminiProtocolError } from "./errors.js";
import { GEMINI_MODEL_STATE_TYPE, type GeminiContent, type GeminiGenerateContentRequest, type GeminiModelStateData, type GeminiPart, type GeminiUsageMetadata } from "./protocol.js";

export function toGeminiRequestParts(messages: readonly Message[]): Pick<GeminiGenerateContentRequest, "contents" | "systemInstruction"> {
  const contents: GeminiContent[] = [];
  const system: GeminiPart[] = [];
  const nativeCalls = new Map<string, NonNullable<GeminiPart["functionCall"]>>();
  for (const message of messages) {
    if (message.role === "system") {
      system.push(...message.content.map((part) => {
        if (part.type === "text") return { text: part.text };
        if (part.type === "json") return { text: JSON.stringify(part.value) };
        throw new UnsupportedContentError("Google Gemini", part.type, "system");
      }));
      continue;
    }
    if (message.role === "tool") {
      const call = nativeCalls.get(message.toolCallId);
      if (call === undefined || call.name !== message.name) throw new GeminiProtocolError(`Unmatched Gemini tool result "${message.toolCallId}"`);
      const response: Record<string, unknown> = {
        [message.isError ? "error" : "output"]: message.content.map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "json") return part.value;
          throw new UnsupportedContentError("Google Gemini", part.type, "tool");
        }),
      };
      appendContent(contents, "user", [{ functionResponse: { name: call.name, ...(call.id === undefined ? {} : { id: call.id }), response } }]);
      continue;
    }
    if (message.role === "assistant") {
      let parts: GeminiPart[];
      if (message.modelState?.type === GEMINI_MODEL_STATE_TYPE) {
        const state = message.modelState.data as GeminiModelStateData;
        if (!isRecord(state) || !Array.isArray(state.parts) || !Array.isArray(state.toolCallIds)) throw new GeminiProtocolError("Malformed Gemini model state");
        parts = structuredClone(state.parts);
        let index = 0;
        for (const part of parts) {
          if (!isRecord(part)) throw new GeminiProtocolError("Malformed Gemini model state part");
          if (part.functionCall === undefined) continue;
          if (!isRecord(part.functionCall) || typeof part.functionCall.name !== "string" || (part.functionCall.args !== undefined && !isRecord(part.functionCall.args))) throw new GeminiProtocolError("Malformed Gemini model state functionCall");
          const functionCall = part.functionCall as NonNullable<GeminiPart["functionCall"]>;
          const callId = state.toolCallIds[index++];
          const toolCall = message.toolCalls?.find((call) => call.id === callId);
          if (typeof callId !== "string" || toolCall === undefined || toolCall.name !== functionCall.name || JSON.stringify(toolCall.input) !== JSON.stringify(functionCall.args ?? {})) throw new GeminiProtocolError("Gemini model state does not match tool calls");
          nativeCalls.set(callId, functionCall);
        }
        if (index !== state.toolCallIds.length || index !== (message.toolCalls?.length ?? 0)) throw new GeminiProtocolError("Gemini model state has inconsistent tool calls");
      } else {
        parts = message.content.flatMap((part) => part.type === "reasoning" ? [] : [toGeminiPart(part, "assistant")]);
        for (const call of message.toolCalls ?? []) {
          if (!isRecord(call.input)) throw new GeminiProtocolError("Gemini tool input must be an object");
          const functionCall = { id: call.id, name: call.name, args: call.input };
          parts.push({ functionCall });
          nativeCalls.set(call.id, functionCall);
        }
      }
      appendContent(contents, "model", parts);
      continue;
    }
    appendContent(contents, "user", message.content.map((part) => toGeminiPart(part, "user")));
  }
  return { contents, ...(system.length === 0 ? {} : { systemInstruction: { parts: system } }) };
}

function appendContent(contents: GeminiContent[], role: GeminiContent["role"], parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const previous = contents.at(-1);
  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}

function toGeminiPart(part: ContentPart, role: Message["role"]): GeminiPart {
  if (part.type === "text") return { text: part.text };
  if (part.type === "json") return { text: JSON.stringify(part.value) };
  if (part.type === "image" || part.type === "audio" || part.type === "file") {
    if (part.source.type === "base64") return { inlineData: { mimeType: part.source.mediaType, data: part.source.data } };
    if (part.source.type === "url") return { fileData: { fileUri: part.source.url } };
  }
  throw new UnsupportedContentError("Google Gemini", part.type, role);
}

export function convertGeminiUsage(metadata: GeminiUsageMetadata): Usage {
  const input = tokenCount(metadata.promptTokenCount, "promptTokenCount");
  const candidates = tokenCount(metadata.candidatesTokenCount, "candidatesTokenCount");
  const reasoning = tokenCount(metadata.thoughtsTokenCount, "thoughtsTokenCount");
  const cached = tokenCount(metadata.cachedContentTokenCount, "cachedContentTokenCount");
  const total = tokenCount(metadata.totalTokenCount, "totalTokenCount");
  const toolPrompt = tokenCount(metadata.toolUsePromptTokenCount, "toolUsePromptTokenCount");
  const usage: Usage = { tokenRelations: { cachedRead: "input", reasoning: "output" } };
  if (input !== undefined) usage.inputTokens = input;
  if (candidates !== undefined || reasoning !== undefined) usage.outputTokens = tokenCount((candidates ?? 0) + (reasoning ?? 0), "outputTokens")!;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cached !== undefined) usage.cachedReadTokens = cached;
  if (total !== undefined) usage.totalTokens = total;
  if (toolPrompt !== undefined && toolPrompt > 0) usage.items = [{ id: "gemini.toolUsePromptTokenCount", quantity: toolPrompt, unit: "token", includedIn: "unknown" }];
  if (input !== undefined && cached !== undefined && cached > input) throw new GeminiProtocolError("Gemini cachedContentTokenCount exceeds promptTokenCount");
  if (input === undefined || usage.outputTokens === undefined || (toolPrompt ?? 0) > 0) usage.completeness = { status: "partial", reason: "Gemini usage does not completely describe input and output tokens" };
  return usage;
}

function tokenCount(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new GeminiProtocolError(`${field} must be a non-negative safe integer`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
