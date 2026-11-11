import { OpenAICompatibleChatModel } from "./chat-model.js";
import { validateWebSearch, webSearchRequest, type WebSearchOptions } from "../web-search.js";
import { ProviderConfigurationError } from "../errors.js";

/**
 * Provider/model metadata determines concrete supported values.
 * @experimental
 */
export type OpenAIChatCompletionsReasoningEffort = string;

/** @experimental */
export interface OpenAIChatCompletionsModelOptions {
  webSearch?: false | WebSearchOptions;
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
    const search = validateWebSearch("openai-chat-completions", options.webSearch);
    if (search && options.model !== "gpt-5-search-api")
      throw new ProviderConfigurationError("OpenAI Chat webSearch requires gpt-5-search-api");
    if (search === false && options.model === "gpt-5-search-api")
      throw new ProviderConfigurationError("gpt-5-search-api always searches and conflicts with webSearch: false");
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
      extendRequest: (body) => {
        if (store !== undefined) body.store = store;
        if (search) body.web_search_options = webSearchRequest("openai-chat-completions", search);
      },
    });
  }
}
