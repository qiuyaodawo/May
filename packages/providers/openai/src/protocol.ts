export const OPENAI_RESPONSES_MODEL_STATE_TYPE = "openai.responses.output.v1";

export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

export interface OpenAIResponsesModelStateData {
  readonly items: readonly unknown[];
}

export interface OpenAIResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}
