import { OpenAICompatibleChatModel } from "./chat-model.js";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type OpenAIChatCompletionsReasoningEffort = string;

/** @experimental */
export interface OpenAIChatCompletionsModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
  reasoningEffort?: OpenAIChatCompletionsReasoningEffort;
  store?: boolean;
  fetch?: typeof globalThis.fetch;
}

/** @experimental */
export class OpenAIChatCompletionsModel extends OpenAICompatibleChatModel {
  constructor(options: OpenAIChatCompletionsModelOptions) {
    const { store, ...shared } = options;
    super(shared, {
      provider: "OpenAI-compatible chat",
      adapter: "openai-chat-completions",
      errorCodePrefix: "OPENAI_CHAT_COMPLETIONS",
      defaultBaseURL: "https://api.openai.com/v1",
      maxTokensField: "max_completion_tokens",
      streamUsage: true,
      includeToolName: false,
      requireDone: true,
      supportsResponseFormat: true,
      ...(store === undefined
        ? {}
        : {
            extendRequest: (body) => {
              body.store = store;
            },
          }),
    });
  }
}
