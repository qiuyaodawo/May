import { omitUndefined } from "@sortedyuan/may/core";
import { OpenAICompatibleChatModel } from "../openai-compatible/chat-model.js";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type ZhipuReasoningEffort = string;

/** @experimental */
export interface ZhipuModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  thinking?: "enabled" | "disabled";
  clearThinking?: boolean;
  reasoningEffort?: ZhipuReasoningEffort;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

/** @experimental */
export class ZhipuModel extends OpenAICompatibleChatModel {
  constructor(options: ZhipuModelOptions) {
    const { thinking = "enabled", clearThinking = false, maxTokens, ...shared } = options;
    super(omitUndefined({ ...shared, maxOutputTokens: maxTokens }), {
      provider: "Zhipu",
      adapter: "zhipu-chat",
      errorCodePrefix: "ZHIPU",
      defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4",
      maxTokensField: "max_tokens",
      streamUsage: false,
      includeToolName: false,
      requireDone: false,
      supportsResponseFormat: false,
      extendRequest: (body, request) => {
        body.thinking = thinking === "enabled" ? { type: thinking, clear_thinking: clearThinking } : { type: thinking };
        if (request.tools.length > 0) body.tool_stream = true;
      },
    });
  }
}
