import { omitUndefined } from "@sortedyuan/may/core";
import { OpenAICompatibleChatModel } from "../openai-compatible/chat-model.js";
import type { WebSearchOptions } from "../web-search.js";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type DeepSeekReasoningEffort = string;

/** @experimental */
export interface DeepSeekModelOptions {
  webSearch?: false | WebSearchOptions;
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: DeepSeekReasoningEffort;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

/** @experimental */
export class DeepSeekModel extends OpenAICompatibleChatModel {
  constructor(options: DeepSeekModelOptions) {
    const { thinking, maxTokens, ...shared } = options;
    super(omitUndefined({ ...shared, maxOutputTokens: maxTokens }), {
      provider: "DeepSeek",
      adapter: "deepseek-chat",
      errorCodePrefix: "DEEPSEEK",
      defaultBaseURL: "https://api.deepseek.com",
      maxTokensField: "max_tokens",
      streamUsage: true,
      includeToolName: false,
      requireDone: false,
      supportsResponseFormat: false,
      ...(thinking === undefined
        ? {}
        : {
            extendRequest: (body) => {
              body.thinking = { type: thinking };
            },
          }),
    });
  }
}
