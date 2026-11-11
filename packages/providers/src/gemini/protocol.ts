import type { JsonSchema } from "@sortedyuan/may/core";

/** @experimental */
export const GEMINI_MODEL_STATE_TYPE = "google-gemini.content.v1";

/** @experimental */
export interface GeminiPart {
  toolCall?: { id?: string; toolType: string; toolName?: string; args?: Record<string, unknown> };
  toolResponse?: { id?: string; toolType: string; response?: Record<string, unknown> };
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
}

/** @experimental */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** @experimental */
export interface GeminiModelStateData {
  origin?: import("../web-search.js").ServerToolOrigin;
  groundingMetadata?: import("./grounding.js").GeminiGrounding;
  parts: GeminiPart[];
  toolCallIds: string[];
}

/** @experimental */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

/** @experimental */
export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: (
    | { functionDeclarations: { name: string; description: string; parametersJsonSchema: JsonSchema }[] }
    | { googleSearch: Record<string, unknown> }
  )[];
  toolConfig?: { includeServerSideToolInvocations: true };
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number; includeThoughts?: boolean };
    responseMimeType?: "application/json";
    responseJsonSchema?: JsonSchema;
  };
}
