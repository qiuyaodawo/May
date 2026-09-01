export const OPENAI_RESPONSES_MODEL_STATE_TYPE = "openai.responses.output.v1";

/** Provider/model metadata determines concrete supported values. */
export type OpenAIReasoningEffort = string;

export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

export interface OpenAIResponsesModelStateData {
  readonly items: readonly unknown[];
}

export interface OpenAIResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}
