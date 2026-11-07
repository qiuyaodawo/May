import { omitUndefined } from "@sortedyuan/may/core";
import { OpenAICompatibleChatModel } from "../openai-compatible/chat-model.js";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type KimiReasoningEffort = string;

/** @experimental */
export interface KimiThinkingConfig {
  type: "enabled" | "disabled";
  keep?: "all" | null;
}

/** @experimental */
export interface KimiModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: Readonly<KimiThinkingConfig>;
  reasoningEffort?: KimiReasoningEffort;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

/** @experimental */
export class KimiModel extends OpenAICompatibleChatModel {
  constructor(options: KimiModelOptions) {
    const { thinking, maxTokens, ...shared } = options;
    const configured = thinking === undefined ? undefined : { ...thinking };
    super(omitUndefined({ ...shared, maxOutputTokens: maxTokens }), {
      provider: "Kimi",
      adapter: "kimi-chat",
      errorCodePrefix: "KIMI",
      defaultBaseURL: "https://api.moonshot.ai/v1",
      maxTokensField: "max_completion_tokens",
      streamUsage: true,
      includeToolName: true,
      requireDone: true,
      supportsResponseFormat: false,
      ...(configured === undefined
        ? {}
        : {
            extendRequest: (body) => {
              body.thinking = { ...configured };
            },
          }),
    });
  }
}
