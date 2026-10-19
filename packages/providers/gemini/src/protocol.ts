import type { JsonSchema } from "@sortedyuan/core";

export const GEMINI_MODEL_STATE_TYPE = "google-gemini.content.v1";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiModelStateData {
  parts: GeminiPart[];
  toolCallIds: string[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: { functionDeclarations: { name: string; description: string; parametersJsonSchema: JsonSchema }[] }[];
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number; includeThoughts?: boolean };
    responseMimeType?: "application/json";
    responseJsonSchema?: JsonSchema;
  };
}
