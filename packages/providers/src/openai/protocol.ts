/** @experimental */
export const OPENAI_RESPONSES_MODEL_STATE_TYPE = "openai.responses.output.v1";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type OpenAIReasoningEffort = string;

/** @experimental */
export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

/** @experimental */
export interface OpenAIResponsesModelStateData {
  readonly items: readonly unknown[];
}

/** @experimental */
export interface OpenAIResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}
