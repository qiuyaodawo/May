import type { Citation, ContentPart, ServerToolCall, ServerToolSource } from "@sortedyuan/may/core";
import { GeminiProtocolError } from "./errors.js";

export interface GeminiGrounding {
  groundingChunks: unknown[];
  groundingSupports: unknown[];
  webSearchQueries: unknown[];
}

export function applyGeminiGrounding(
  grounding: GeminiGrounding,
  textParts: Map<number, Extract<ContentPart, { type: "text" }>>,
  responseId: string,
): ServerToolCall | undefined {
  if (
    grounding.groundingChunks.length === 0 &&
    grounding.webSearchQueries.length === 0 &&
    grounding.groundingSupports.length === 0
  )
    return undefined;
  const sources = grounding.groundingChunks.map((raw): ServerToolSource | undefined => {
    const chunk = record(raw);
    if (chunk.web === undefined) return undefined;
    const web = record(chunk.web);
    if (typeof web.uri !== "string") throw new GeminiProtocolError("grounding web.uri must be a string");
    return { url: web.uri, ...(typeof web.title === "string" ? { title: web.title } : {}) };
  });
  for (const raw of grounding.groundingSupports) {
    const support = record(raw);
    const segment = record(support.segment);
    const index = segment.partIndex ?? 0;
    if (!Number.isSafeInteger(index)) throw new GeminiProtocolError("Invalid grounding segment.partIndex");
    const part = textParts.get(index as number);
    if (part === undefined) throw new GeminiProtocolError("grounding segment references a non-text Part");
    const start = utf16Position(part.text, segment.startIndex ?? 0);
    const end = utf16Position(part.text, segment.endIndex);
    if (end < start) throw new GeminiProtocolError("Invalid grounding segment range");
    if (!Array.isArray(support.groundingChunkIndices))
      throw new GeminiProtocolError("groundingChunkIndices must be an array");
    for (const sourceIndex of support.groundingChunkIndices) {
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sources.length)
        throw new GeminiProtocolError("Invalid grounding chunk index");
      const source = sources[sourceIndex];
      if (source === undefined) continue;
      const citation: Citation = {
        type: "url",
        ...source,
        range: { start, end },
        citedText: part.text.slice(start, end),
      };
      const citations = (part.citations ??= []);
      if (
        !citations.some(
          (existing) => existing.url === citation.url && existing.range?.start === start && existing.range?.end === end,
        )
      )
        citations.push(citation);
    }
  }
  if (grounding.webSearchQueries.some((query) => typeof query !== "string"))
    throw new GeminiProtocolError("webSearchQueries must contain strings");
  return {
    id: `may:grounding:${responseId}`,
    kind: "web_search",
    name: "web_search",
    input: { queries: grounding.webSearchQueries },
    status: "completed",
    sources: sources.filter((source): source is ServerToolSource => source !== undefined),
  };
}

function utf16Position(text: string, byteIndex: unknown): number {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(byteIndex) || (byteIndex as number) < 0 || (byteIndex as number) > bytes.length)
    throw new GeminiProtocolError("Invalid grounding UTF-8 byte position");
  const index = byteIndex as number;
  if (index < bytes.length && (bytes[index]! & 0xc0) === 0x80)
    throw new GeminiProtocolError("grounding position is inside a UTF-8 character");
  return bytes.subarray(0, index).toString("utf8").length;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new GeminiProtocolError("Malformed grounding metadata");
  return value as Record<string, unknown>;
}
